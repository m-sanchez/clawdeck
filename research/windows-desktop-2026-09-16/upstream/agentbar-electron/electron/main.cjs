const { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, session, shell, Tray } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { getSummary } = require("./usageReader.cjs");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const appUrl = isDev
  ? process.env.VITE_DEV_SERVER_URL
  : `file://${path.join(__dirname, "..", "dist", "index.html")}`;
const CLAUDE_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const startHidden = process.argv.includes("--hidden") || process.argv.includes("--background");
const startVisible = process.argv.includes("--show");

let tray = null;
let popover = null;
let dashboard = null;
let claudeConnect = null;
let claudeConnectDone = false;
let summaryCache = null;
app.isQuitting = false;

app.setAppUserModelId("io.github.agentbar");
app.setName("AgentBar");

const singleLock = app.requestSingleInstanceLock();
if (!singleLock) app.quit();
app.on("second-instance", () => {
  if (app.isReady()) showPopover();
});

app.whenReady().then(() => {
  process.env.AI_USAGE_DATA_DIR = app.getPath("userData");
  summaryCache = loadingSummary();
  configureAutoLaunchFromSettings();
  createTray();
  createPopover();
  refreshSummary();
  setInterval(refreshSummary, 5_000);
  setTimeout(() => {
    if (!startHidden && startVisible) showPopover();
  }, 500);
});

app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  app.isQuitting = true;
});

ipcMain.handle("summary:get", async () => {
  if (!summaryCache?.services?.length) return refreshSummary();
  return summaryCache;
});
ipcMain.handle("summary:refresh", () => refreshSummary());
ipcMain.handle("window:dashboard", () => showDashboard());
ipcMain.handle("claude:connect", () => showClaudeConnect());
ipcMain.handle("shell:openExternal", (_event, url) => shell.openExternal(url));

function createTray() {
  tray = new Tray(createTrayIcon(0, 0));
  tray.setToolTip("AgentBar");
  tray.on("click", () => togglePopover());
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Mostrar resumen", click: () => showPopover() },
      { label: "Usage Dashboard", click: () => showDashboard() },
      { label: "Conectar Claude", click: () => showClaudeConnect() },
      { type: "separator" },
      {
        label: "Iniciar con Windows",
        type: "checkbox",
        checked: isAutoLaunchEnabled(),
        click: (item) => setAutoLaunch(item.checked),
      },
      { label: "Mostrar icono en la barra...", click: () => shell.openExternal("ms-settings:taskbar") },
      { label: "Actualizar", click: () => refreshSummary() },
      { label: "Salir", click: () => app.quit() },
    ]),
  );
}

function showClaudeConnect() {
  if (!claudeConnect || claudeConnect.isDestroyed()) {
    claudeConnectDone = false;
    const claudeSession = session.fromPartition("persist:claude-web");
    claudeSession.webRequest.onBeforeSendHeaders(
      { urls: ["https://claude.ai/*", "https://*.claude.ai/*", "https://challenges.cloudflare.com/*"] },
      (details, callback) => {
        callback({
          requestHeaders: {
            ...details.requestHeaders,
            "Accept-Language": details.requestHeaders["Accept-Language"] || "es-ES,es;q=0.9,en;q=0.8",
            "User-Agent": CLAUDE_BROWSER_USER_AGENT,
          },
        });
      },
    );
    claudeConnect = new BrowserWindow({
      width: 1120,
      height: 820,
      icon: createTrayIcon(0, 0),
      title: "Conectar Claude",
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        partition: "persist:claude-web",
      },
    });
    claudeConnect.webContents.setUserAgent(CLAUDE_BROWSER_USER_AGENT);
    claudeSession.clearCache().finally(() => restoreClaudeSession(claudeSession)).finally(() => {
      if (isAlive(claudeConnect)) claudeConnect.loadURL("https://claude.ai/settings/usage");
    });
    attachDebugLogging(claudeConnect, "claude-connect");
    const timer = setInterval(() => captureClaudeSessionAndClose(claudeConnect), 2_000);
    claudeConnect.on("closed", () => {
      clearInterval(timer);
      claudeConnect = null;
    });
    claudeConnect.webContents.on("did-finish-load", () => captureClaudeSessionAndClose(claudeConnect));
    claudeConnect.webContents.on("did-navigate", () => captureClaudeSessionAndClose(claudeConnect));
  }
  claudeConnect.show();
  claudeConnect.focus();
}

async function captureClaudeSessionAndClose(window) {
  if (claudeConnectDone || !isAlive(window)) return;
  const captured = await captureClaudeSession(window);
  if (!captured || !isAlive(window)) return;

  claudeConnectDone = true;
  window.close();
  showPopover();
}

async function captureClaudeSession(window) {
  if (!isAlive(window)) return false;
  try {
    const cookies = await window.webContents.session.cookies.get({ url: "https://claude.ai" });
    const sessionKey = cookies.find((cookie) => cookie.value?.startsWith("sk-ant-"))?.value;
    if (!sessionKey) return false;

    const dataDir = app.getPath("userData");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "claude-cookie.txt"), `sessionKey=${sessionKey}`, { encoding: "utf8", mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, "claude-cookies.json"), JSON.stringify(safeClaudeCookies(cookies), null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await window.webContents.session.cookies.flushStore();
    const summary = await refreshSummary();
    const claude = summary.services.find((service) => service.id === "claude");
    return Boolean(claude?.limits?.length);
  } catch (error) {
    console.error(`[claude-connect] ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function restoreClaudeSession(claudeSession) {
  const cookiesPath = path.join(app.getPath("userData"), "claude-cookies.json");
  let saved = [];

  try {
    saved = JSON.parse(fs.readFileSync(cookiesPath, "utf8"));
  } catch {
    const sessionKey = readSavedClaudeSessionKey();
    if (sessionKey) {
      saved = [{ name: "sessionKey", value: sessionKey, domain: ".claude.ai", path: "/", secure: true, httpOnly: true }];
    }
  }

  const now = Date.now() / 1000;
  for (const cookie of saved) {
    if (!cookie?.name || !cookie?.value) continue;
    if (cookie.expirationDate && cookie.expirationDate <= now) continue;
    try {
      await claudeSession.cookies.set({
        url: "https://claude.ai",
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || ".claude.ai",
        path: cookie.path || "/",
        secure: cookie.secure !== false,
        httpOnly: Boolean(cookie.httpOnly),
        expirationDate: cookie.expirationDate,
        sameSite: cookie.sameSite,
      });
    } catch (error) {
      console.error(`[claude-connect] cookie restore failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await claudeSession.cookies.flushStore();
}

function safeClaudeCookies(cookies) {
  const wanted = new Set([
    "sessionKey",
    "cf_clearance",
    "routingHint",
    "lastActiveOrg",
    "anthropic-device-id",
    "anthropic-consent-preferences",
  ]);

  return cookies
    .filter((cookie) => wanted.has(cookie.name) || cookie.name.startsWith("_dd_") || cookie.name === "_dd_s")
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expirationDate: cookie.expirationDate,
      sameSite: cookie.sameSite,
    }));
}

function readSavedClaudeSessionKey() {
  try {
    const raw = fs.readFileSync(path.join(app.getPath("userData"), "claude-cookie.txt"), "utf8").trim();
    return raw.match(/(?:^|;\s*)sessionKey=([^;]+)/)?.[1] || (raw.startsWith("sk-ant-") ? raw : null);
  } catch {
    return null;
  }
}

function createPopover() {
  popover = new BrowserWindow({
    width: 330,
    height: 640,
    minWidth: 300,
    minHeight: 420,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    icon: createTrayIcon(0, 0),
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  popover.loadURL(`${appUrl}${isDev ? "" : ""}`);
  attachDebugLogging(popover, "popover");
  popover.webContents.on("did-finish-load", () => sendSummary(popover));
  popover.on("blur", () => {
    if (isAlive(popover) && popover.isVisible()) popover.hide();
  });
  popover.on("closed", () => {
    popover = null;
  });
}

function showDashboard() {
  if (!dashboard || dashboard.isDestroyed()) {
    dashboard = new BrowserWindow({
      width: 460,
      height: 720,
      backgroundColor: "#5b58f6",
      icon: createTrayIcon(0, 0),
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    dashboard.loadURL(appUrl);
    attachDebugLogging(dashboard, "dashboard");
    dashboard.webContents.on("did-finish-load", () => sendSummary(dashboard));
    dashboard.on("close", (event) => {
      if (!app.isQuitting) {
        event.preventDefault();
        dashboard.hide();
      }
    });
    dashboard.on("closed", () => {
      dashboard = null;
    });
  }
  dashboard.show();
  dashboard.focus();
}

function togglePopover() {
  if (!isAlive(popover)) createPopover();
  if (popover.isVisible()) {
    popover.hide();
  } else {
    showPopover();
  }
}

function showPopover() {
  if (!isAlive(popover)) createPopover();
  refreshSummary();
  resizePopoverForDisplay();
  positionPopover();
  popover.show();
  popover.focus();
}

function resizePopoverForDisplay() {
  if (!isAlive(popover) || !tray) return;
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const height = Math.max(420, Math.min(680, display.workArea.height - 24));
  const width = Math.max(306, Math.min(344, display.workArea.width - 16));
  popover.setSize(width, height, false);
}

function positionPopover() {
  if (!isAlive(popover) || !tray) return;
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const workArea = display.workArea;
  const [width, height] = popover.getSize();
  const x = Math.round(Math.min(Math.max(trayBounds.x + trayBounds.width / 2 - width / 2, workArea.x), workArea.x + workArea.width - width));
  const y = Math.round(trayBounds.y > workArea.y + workArea.height / 2 ? trayBounds.y - height - 8 : trayBounds.y + trayBounds.height + 8);
  popover.setPosition(x, y, false);
}

async function refreshSummary() {
  summaryCache = await safeSummary();
  const codex = summaryCache.services.find((service) => service.id === "codex");
  const claude = summaryCache.services.find((service) => service.id === "claude");
  tray?.setImage(createTrayIcon(codex?.limits?.[0]?.usedPercent || 0, claude?.limits?.[0]?.usedPercent || 0));
  tray?.setToolTip(`AgentBar - ${summaryCache.activeSources}/${summaryCache.totalSources} fuentes`);
  updateTrayMenu();
  sendSummary(popover);
  sendSummary(dashboard);
  return summaryCache;
}

function sendSummary(window) {
  if (!isAlive(window)) return;
  window.webContents.send("summary:updated", summaryCache);
}

function isAlive(window) {
  return Boolean(window && !window.isDestroyed());
}

async function safeSummary() {
  try {
    return await getSummary();
  } catch (error) {
    return {
      generatedAt: new Date().toISOString(),
      activeSources: 0,
      totalSources: 5,
      services: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function loadingSummary() {
  return {
    generatedAt: new Date().toISOString(),
    activeSources: 0,
    totalSources: 5,
    services: [],
  };
}

function configureAutoLaunchFromSettings() {
  const settings = readSettings();
  if (settings.openAtLogin === undefined) {
    settings.openAtLogin = true;
    writeSettings(settings);
  }
  setAutoLaunch(Boolean(settings.openAtLogin));
}

function setAutoLaunch(enabled) {
  const settings = readSettings();
  settings.openAtLogin = Boolean(enabled);
  writeSettings(settings);

  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args: app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"],
    });
  } catch (error) {
    console.error(`[startup] ${error instanceof Error ? error.message : String(error)}`);
  }
  updateTrayMenu();
}

function isAutoLaunchEnabled() {
  try {
    return app.getLoginItemSettings({
      path: process.execPath,
      args: app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"],
    }).openAtLogin;
  } catch {
    return Boolean(readSettings().openAtLogin);
  }
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function createTrayIcon(topPercent, bottomPercent) {
  const topWidth = Math.max(3, Math.round((topPercent / 100) * 20));
  const bottomWidth = Math.max(3, Math.round((bottomPercent / 100) * 20));
  return nativeImage.createFromBuffer(createTrayPng(topWidth, bottomWidth));
}

function createTrayPng(topWidth, bottomWidth) {
  const width = 32;
  const height = 32;
  const pixels = Buffer.alloc(width * height * 4);

  fillRoundedRect(pixels, width, height, 2, 2, 28, 28, 8, [16, 124, 196, 255]);
  fillRoundedRect(pixels, width, height, 4, 4, 24, 24, 7, [28, 151, 234, 255]);
  fillRoundedRect(pixels, width, height, 7, 7, 18, 14, 5, [255, 255, 255, 242]);
  fillRoundedRect(pixels, width, height, 10, 10, 12, 2, 1, [16, 124, 196, 255]);
  fillRoundedRect(pixels, width, height, 10, 14, 9, 2, 1, [16, 124, 196, 255]);
  fillRoundedRect(pixels, width, height, 10, 18, 6, 2, 1, [16, 124, 196, 255]);
  setPixelRect(pixels, width, 23, 8, 2, 2, [255, 255, 255, 245]);
  setPixelRect(pixels, width, 22, 10, 4, 2, [255, 255, 255, 245]);
  setPixelRect(pixels, width, 23, 12, 2, 2, [255, 255, 255, 245]);
  fillRoundedRect(pixels, width, height, 6, 24, 20, 2, 1, [255, 255, 255, 74]);
  fillRoundedRect(pixels, width, height, 6, 27, 20, 2, 1, [255, 255, 255, 74]);
  fillRoundedRect(pixels, width, height, 6, 24, topWidth, 2, 1, [255, 185, 0, 255]);
  fillRoundedRect(pixels, width, height, 6, 27, bottomWidth, 2, 1, [96, 205, 255, 255]);

  return encodePng(width, height, pixels);
}

function setPixelRect(pixels, imageWidth, x, y, width, height, color) {
  for (let row = y; row < y + height; row += 1) {
    for (let col = x; col < x + width; col += 1) {
      const index = (row * imageWidth + col) * 4;
      pixels[index] = color[0];
      pixels[index + 1] = color[1];
      pixels[index + 2] = color[2];
      pixels[index + 3] = color[3];
    }
  }
}

function fillRoundedRect(pixels, imageWidth, imageHeight, x, y, width, height, radius, color) {
  for (let row = y; row < y + height; row += 1) {
    for (let col = x; col < x + width; col += 1) {
      const left = col < x + radius;
      const right = col >= x + width - radius;
      const top = row < y + radius;
      const bottom = row >= y + height - radius;
      if ((left && top && distance(col, row, x + radius, y + radius) > radius)
        || (right && top && distance(col, row, x + width - radius - 1, y + radius) > radius)
        || (left && bottom && distance(col, row, x + radius, y + height - radius - 1) > radius)
        || (right && bottom && distance(col, row, x + width - radius - 1, y + height - radius - 1) > radius)) {
        continue;
      }
      if (col >= 0 && col < imageWidth && row >= 0 && row < imageHeight) {
        const index = (row * imageWidth + col) * 4;
        pixels[index] = color[0];
        pixels[index + 1] = color[1];
        pixels[index + 2] = color[2];
        pixels[index + 3] = color[3];
      }
    }
  }
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function encodePng(width, height, rgba) {
  const zlib = require("node:zlib");
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const target = y * (width * 4 + 1);
    scanlines[target] = 0;
    rgba.copy(scanlines, target + 1, y * width * 4, (y + 1) * width * 4);
  }

  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  return Buffer.concat([
    signature,
    pngChunk("IHDR", Buffer.concat([uint32(width), uint32(height), Buffer.from([8, 6, 0, 0, 0])])),
    pngChunk("IDAT", zlib.deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  return Buffer.concat([uint32(data.length), name, data, uint32(crc32(Buffer.concat([name, data])))]); 
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function attachDebugLogging(window, label) {
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[${label}] failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.error(`[${label}] ${message}`);
  });
}
