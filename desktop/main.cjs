const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  protocol,
  net,
  screen,
  nativeImage,
  nativeTheme,
  Notification,
  utilityProcess,
  shell,
  dialog,
  powerMonitor,
} = require("electron");
const { join, resolve, relative, extname, isAbsolute } = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomBytes } = require("node:crypto");
const { readFileSync, mkdirSync } = require("node:fs");
const { stat, realpath } = require("node:fs/promises");
const { createServer } = require("node:net");
const { Preferences, recoverBounds } = require("./lib/preferences.cjs");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "ocelin",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
app.commandLine.appendSwitch("force-renderer-accessibility");
const core = app.isPackaged
  ? join(process.resourcesPath, "core")
  : resolve(__dirname, "..");
const dataDir =
  process.env.OCELIN_DATA_DIR ||
  join(process.env.LOCALAPPDATA || app.getPath("userData"), "Ocelin");
app.setPath("userData", dataDir);
app.setAppUserModelId("uk.co.miguelsanchez.ocelin");
const preferences = new Preferences(dataDir);
const windows = new Map();
let tray,
  monitor,
  integrations,
  quitting = false,
  project = null,
  sequence = 0,
  projectOpening = false;
let snapshot = {
  sessions: [],
  counts: { running: 0, attention: 0, unseen: 0 },
  diagnostics: [],
  metrics: {},
};
let error = null;
const requests = new Map();
const icon = () =>
  nativeImage.createFromPath(join(__dirname, "assets", "ocelin.png"));
const state = () => ({
  ...snapshot,
  preferences: preferences.value,
  error,
  version: app.getVersion(),
  packaged: app.isPackaged,
});
function publish() {
  for (const window of windows.values())
    if (!window.isDestroyed()) window.webContents.send("ocelin:state", state());
  if (tray)
    tray.setToolTip(
      `Ocelin · ${snapshot.counts.running} running · ${snapshot.counts.attention} need you`,
    );
  if (project) project.worker.postMessage({ type: "snapshot", snapshot });
}
function request(type, args = {}) {
  return new Promise((resolveRequest, reject) => {
    if (!monitor) return reject(new Error("Monitor is unavailable"));
    const id = ++sequence;
    const timeout = setTimeout(() => {
      requests.delete(id);
      reject(new Error("Monitor is still loading; try again"));
    }, 30000);
    requests.set(id, { resolve: resolveRequest, reject, timeout });
    monitor.postMessage({ id, type, ...args });
  });
}
function startMonitor() {
  monitor = utilityProcess.fork(
    join(core, "server", "monitor", "worker.mjs"),
    [],
    {
      env: {
        ...process.env,
        OCELIN_DATA_DIR: dataDir,
        ...(preferences.value.sources
          ? { OCELIN_SOURCES: JSON.stringify(preferences.value.sources) }
          : {}),
      },
      serviceName: "Ocelin session monitor",
      stdio: "pipe",
    },
  );
  monitor.postMessage({ type: "preferences", value: preferences.value });
  monitor.stderr.on("data", (chunk) => {
    error = `Monitor: ${String(chunk).slice(0, 300)}`;
    publish();
  });
  monitor.on("message", (message) => {
    if (message.type === "snapshot") {
      snapshot = message.snapshot;
      error = null;
      publish();
    }
    if (message.type === "error") {
      error = message.message;
      publish();
    }
    if (message.type === "reply") {
      const pending = requests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        requests.delete(message.id);
        message.error
          ? pending.reject(new Error(message.error))
          : pending.resolve(message.value);
      }
    }
    if (message.type === "notification" && Notification.isSupported()) {
      const s = message.session;
      const toast = new Notification({
        title: `Ocelin · ${s.provider === "codex" ? "Codex" : "Claude"}`,
        body: `${s.title}: ${s.label}`,
        icon: icon(),
        silent: !preferences.value.sound,
      });
      toast.on("click", () => {
        showWindow("dashboard");
      });
      toast.show();
    }
  });
  monitor.on("exit", () => {
    monitor = null;
    for (const pending of requests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Monitor restarted"));
    }
    requests.clear();
    if (!quitting) {
      error = "Monitor restarting";
      publish();
      setTimeout(startMonitor, 3000);
    }
  });
}
function secure(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("ocelin://app/")) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, done) => done(false),
  );
}
function createWindow(kind) {
  const work = screen.getPrimaryDisplay().workArea;
  const fallback =
    kind === "bar"
      ? {
          x: work.x + 120,
          y: work.y + 24,
          width: Math.min(850, work.width),
          height: 96,
        }
      : kind === "tray"
        ? {
            x: work.x + work.width - 430,
            y: work.y + work.height - 610,
            width: 420,
            height: 590,
          }
        : {
            x: work.x + 60,
            y: work.y + 60,
            width: Math.min(1120, work.width),
            height: Math.min(800, work.height),
          };
  const window = new BrowserWindow({
    ...recoverBounds(
      preferences.value.bounds[kind],
      screen.getAllDisplays(),
      fallback,
    ),
    title: "Ocelin",
    icon: icon(),
    show: false,
    frame: kind === "dashboard",
    resizable: kind !== "tray",
    minWidth: 320,
    minHeight: kind === "bar" ? 82 : 360,
    skipTaskbar: kind !== "dashboard",
    alwaysOnTop: kind !== "dashboard" && preferences.value.alwaysOnTop,
    backgroundColor: "#171a19",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  windows.set(kind, window);
  secure(window);
  window.webContents.on("console-message", (details) => {
    if (details?.level === "error")
      console.error(`${kind}: ${details.message}`);
  });
  window.webContents.on("did-finish-load", () =>
    console.log(`Ocelin ${kind} ready`),
  );
  window
    .loadURL(`ocelin://app/desktop/renderer/index.html?surface=${kind}`)
    .catch((e) => {
      error = `${kind}: ${e.message}`;
      publish();
    });
  window.once("ready-to-show", () => {
    if (window.ocelinVisible) {
      window.showInactive();
      if (window.ocelinFocus) window.focus();
    }
  });
  let saveTimer;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!window.isDestroyed())
        preferences.save({
          bounds: { ...preferences.value.bounds, [kind]: window.getBounds() },
        });
    }, 300);
  };
  window.on("move", saveBounds);
  window.on("resize", saveBounds);
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (
      tray ||
      [...windows.values()].some((w) => w !== window && w.isVisible())
    )
      window.hide();
    else showWindow("dashboard");
  });
  if (kind === "tray") window.on("blur", () => window.hide());
  return window;
}
function showWindow(kind, focus = true) {
  const window = windows.get(kind) || createWindow(kind);
  window.ocelinVisible = true;
  window.ocelinFocus = focus;
  if (kind === "tray" && tray) {
    const bounds = tray.getBounds();
    const area = screen.getDisplayNearestPoint({
      x: bounds.x,
      y: bounds.y,
    }).workArea;
    window.setPosition(
      Math.max(area.x, Math.min(bounds.x - 380, area.x + area.width - 420)),
      Math.max(area.y, area.y + area.height - window.getBounds().height - 8),
    );
  }
  if (!window.webContents.isLoading()) {
    focus ? window.show() : window.showInactive();
    if (focus) window.focus();
  }
}
function applySurfaces() {
  if (preferences.value.tray && !tray) {
    tray = new Tray(icon());
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Ocelin", click: () => showWindow("dashboard") },
        { label: "Session panel", click: () => showWindow("tray") },
        {
          label: "Toggle floating bar",
          click: () => {
            preferences.update({ bar: !preferences.value.bar });
            applySurfaces();
            publish();
          },
        },
        { type: "separator" },
        { label: "Quit Ocelin", click: () => app.quit() },
      ]),
    );
    tray.on("click", () => {
      const panel = windows.get("tray");
      panel?.isVisible() ? panel.hide() : showWindow("tray");
    });
    tray.on("double-click", () => showWindow("dashboard"));
  } else if (!preferences.value.tray && tray) {
    tray.destroy();
    tray = null;
    windows.get("tray")?.hide();
  }
  for (const kind of ["bar", "dashboard"]) {
    if (preferences.value[kind]) showWindow(kind, false);
    else windows.get(kind)?.hide();
  }
  for (const kind of ["bar", "tray"])
    windows.get(kind)?.setAlwaysOnTop(preferences.value.alwaysOnTop);
  nativeTheme.themeSource = preferences.value.theme;
  monitor?.postMessage({ type: "preferences", value: preferences.value });
  publish();
}
async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}
async function closeProject() {
  if (!project) return;
  const old = project;
  project = null;
  old.window.destroy();
  old.worker.postMessage({ type: "stop" });
  setTimeout(() => old.worker.kill(), 2000).unref();
}
async function openProject(key) {
  const target = await request("target", { key });
  const cwd = await realpath(target.cwd);
  if (/^[/\\]{2}/.test(cwd) || !(await stat(cwd)).isDirectory())
    throw new Error("Project directory is unavailable");
  await closeProject();
  const port = await freePort();
  const nonce = randomBytes(24).toString("hex");
  const runtime = join(dataDir, "dashboard", nonce);
  mkdirSync(runtime, { recursive: true });
  const worker = utilityProcess.fork(
    join(core, "server", "monitor", "dashboard-worker.mjs"),
    [],
    {
      cwd,
      serviceName: "Ocelin project dashboard",
      stdio: "pipe",
      env: {
        ...process.env,
        PANEL_CHECKOUT_ROOT: cwd,
        PANEL_REPO_ROOT: cwd,
        PANEL_CHECKOUT_ID: "ocelin-desktop",
        PANEL_RUNTIME_DIR: runtime,
        PANEL_SERVICE_PORT: String(port),
        PANEL_NONCE: nonce,
      },
    },
  );
  worker.postMessage({ type: "snapshot", snapshot });
  const window = new BrowserWindow({
    width: 1200,
    height: 850,
    title: "Ocelin",
    icon: icon(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  project = { worker, window, cwd, port, nonce };
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
      showWindow("dashboard");
    }
  });
  const origin = `http://127.0.0.1:${port}`;
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const link = new URL(url);
      if (
        link.protocol === "https:" &&
        ["github.com", "gitlab.com"].includes(link.hostname)
      )
        void shell.openExternal(link.href);
    } catch {}
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  let ready = false;
  for (let tries = 0; tries < 150; tries++) {
    try {
      const health = await (await net.fetch(`${origin}/health`)).json();
      if (health.nonce === nonce) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  if (!ready) {
    await closeProject();
    throw new Error("Project dashboard did not become ready");
  }
  const token = readFileSync(join(runtime, "panel.token"), "utf8").trim();
  await window.loadURL(
    `${origin}/?desktop=1&provider=${target.provider}&session=${encodeURIComponent(target.sessionId)}#token=${token}&/activity/session`,
  );
  window.show();
  return true;
}
function trusted(event) {
  return (
    [...windows.values()].some(
      (w) =>
        !w.isDestroyed() &&
        w.webContents === event.sender &&
        event.senderFrame === w.webContents.mainFrame,
    ) && event.senderFrame.url.startsWith("ocelin://app/desktop/renderer/")
  );
}
async function action(name, args = {}) {
  if (name === "preferences") {
    const previousStartup = preferences.value.startup;
    preferences.update(args);
    if (preferences.value.startup !== previousStartup) {
      if (!app.isPackaged) {
        preferences.save({ startup: false });
        throw new Error("Sign-in startup is available after installing Ocelin");
      }
      app.setLoginItemSettings({
        openAtLogin: preferences.value.startup,
        path: process.execPath,
        args: ["--background"],
      });
    }
    applySurfaces();
    return state();
  }
  if (name === "acknowledge") return request("acknowledge", { key: args.key });
  if (name === "project") {
    if (projectOpening)
      throw new Error("A project is opening; try again when it is ready");
    projectOpening = true;
    try {
      return await openProject(args.key);
    } finally {
      projectOpening = false;
    }
  }
  if (name === "folder") {
    const target = await request("target", { key: args.key });
    const path = await realpath(target.cwd);
    if (/^[/\\]{2}/.test(path) || !(await stat(path)).isDirectory())
      throw new Error("Project directory is unavailable");
    const failure = await shell.openPath(path);
    if (failure) throw new Error(failure);
    return true;
  }
  if (name === "mute-project") {
    const target = await request("target", { key: args.key });
    const set = new Set(preferences.value.mutedProjects);
    set.has(target.cwd) ? set.delete(target.cwd) : set.add(target.cwd);
    preferences.save({ mutedProjects: [...set] });
    monitor.postMessage({ type: "preferences", value: preferences.value });
    publish();
    return true;
  }
  if (name === "refresh") return request("refresh");
  if (name === "show" && ["dashboard", "bar", "tray"].includes(args.surface)) {
    showWindow(args.surface);
    return true;
  }
  if (name === "hide") {
    const window = windows.get(args.surface);
    if (
      window &&
      (tray || [...windows.values()].some((w) => w !== window && w.isVisible()))
    )
      window.hide();
    else showWindow("dashboard");
    return true;
  }
  if (name === "source" && ["claude", "codex"].includes(args.provider)) {
    const result = await dialog.showOpenDialog({
      title: `Select ${args.provider === "codex" ? "Codex sessions" : "Claude projects"} directory`,
      properties: ["openDirectory"],
    });
    if (result.canceled) return false;
    const { defaultSources } = await import(
      pathToFileURL(join(core, "server/monitor/collector.mjs")).href
    );
    const sources = preferences.value.sources || defaultSources();
    const root = await realpath(result.filePaths[0]);
    if (/^[/\\]{2}/.test(root))
      throw new Error("Only local Windows source folders are supported");
    if (!sources.some((s) => s.provider === args.provider && s.root === root))
      sources.push({ provider: args.provider, root });
    preferences.save({ sources });
    await request("sources", { value: sources });
    publish();
    return true;
  }
  if (name === "hook-preview")
    return integrations.preview(args.provider, args.remove === true);
  if (name === "hook-apply") return integrations.apply(args.id);
  if (name === "quit") {
    app.quit();
    return true;
  }
  throw new Error("Unknown Ocelin action");
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => showWindow("dashboard"));
  app.on("window-all-closed", () => {});
  app.on("activate", () => showWindow("dashboard"));
  app.on("before-quit", () => {
    quitting = true;
    monitor?.postMessage({ type: "stop" });
    if (project) project.worker.postMessage({ type: "stop" });
    setTimeout(() => {
      monitor?.kill();
      project?.worker.kill();
    }, 2000).unref();
    tray?.destroy();
    tray = null;
  });
  app
    .whenReady()
    .then(async () => {
      protocol.handle("ocelin", async (request) => {
        const url = new URL(request.url);
        if (url.hostname !== "app" || request.method !== "GET")
          return new Response("Forbidden", { status: 403 });
        const route = decodeURIComponent(url.pathname);
        const base = route.startsWith("/ui/")
          ? join(core, "ui")
          : route.startsWith("/desktop/renderer/")
            ? join(__dirname, "renderer")
            : null;
        if (!base) return new Response("Not found", { status: 404 });
        const path = resolve(
          base,
          route.replace(/^\/(ui|desktop\/renderer)\//, ""),
        );
        if (
          relative(base, path).startsWith("..") ||
          isAbsolute(relative(base, path)) ||
          ![".html", ".mjs", ".css", ".svg", ".png"].includes(extname(path))
        )
          return new Response("Forbidden", { status: 403 });
        return net.fetch(pathToFileURL(path).href);
      });
      const { Integrations } = await import(
        pathToFileURL(join(core, "server/monitor/integrations.mjs")).href
      );
      integrations = new Integrations({
        dataDir,
        runtime: process.execPath,
        captureFile: join(core, "hooks", "ocelin-capture.cjs"),
      });
      ipcMain.handle("ocelin:state", (event) => {
        if (!trusted(event)) throw new Error("Untrusted sender");
        return state();
      });
      ipcMain.handle("ocelin:action", (event, name, args) => {
        if (
          !trusted(event) ||
          typeof name !== "string" ||
          (args != null && (typeof args !== "object" || Array.isArray(args))) ||
          JSON.stringify(args || {}).length > 8192
        )
          throw new Error("Invalid request");
        return action(name, args);
      });
      startMonitor();
      applySurfaces();
      if (
        process.argv.includes("--background") &&
        (tray || windows.get("bar")?.isVisible())
      )
        windows.get("dashboard")?.hide();
      const recover = () => {
        for (const w of windows.values())
          w.setBounds(
            recoverBounds(
              w.getBounds(),
              screen.getAllDisplays(),
              w.getBounds(),
            ),
          );
      };
      screen.on("display-removed", recover);
      screen.on("display-metrics-changed", recover);
      powerMonitor.on("resume", () => {
        request("refresh").catch(() => {});
        recover();
      });
      if (
        process.argv.includes("--smoke-test") &&
        process.env.OCELIN_DATA_DIR
      ) {
        void require("./smoke.cjs")({
          app,
          windows,
          action,
          getState: state,
          getProject: () => project,
          dataDir,
          core,
        });
      }
    })
    .catch((e) => {
      dialog.showErrorBox("Ocelin could not start", e.message);
      app.quit();
    });
}
