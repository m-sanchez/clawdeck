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
  globalShortcut,
} = require("electron");
const { join, resolve, relative, extname, isAbsolute } = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomBytes } = require("node:crypto");
const { readFileSync, mkdirSync, existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { stat, realpath, writeFile } = require("node:fs/promises");
const { createServer } = require("node:net");
const { Worker } = require("node:worker_threads");
const { Preferences, recoverBounds } = require("./lib/preferences.cjs");
const { Resources } = require("./lib/resources.cjs");
const { TaskbarBridge } = require("./lib/taskbar-bridge.cjs");
const { NativeTasks } = require("./lib/native-tasks.cjs");
const {
  sessionLink,
  activation,
  activationUri,
} = require("./lib/session-links.cjs");

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
const taskbarBridge = new TaskbarBridge(dataDir);
const nativeTasks = new NativeTasks(
  dataDir,
  join(
    app.isPackaged ? process.resourcesPath : __dirname,
    "native",
    "activate.ps1",
  ),
  () => publish(),
);
let library,
  librarySequence = 0,
  hiddenKeys = new Set(),
  connections = {};
const libraryRequests = new Map();
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
const resources = new Resources(() => publish());
const requests = new Map();
const icon = () =>
  nativeImage.createFromPath(join(__dirname, "assets", "ocelin.png"));
const state = () => ({
  ...snapshot,
  sessions: snapshot.sessions.filter(s => Date.now() - s.lastTs < 86400000 || !s.stale),
  preferences: preferences.value,
  error,
  version: app.getVersion(),
  packaged: app.isPackaged,
  resources: resources.value,
  taskbarTheme: nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? "dark" : "light",
  nativeTasks: nativeTasks.value,
  connections,
  hiddenKeys: [...hiddenKeys],
});
function publish() {
  taskbarBridge.publish(state(), preferences.value.taskbarBridge);
  nativeTasks.publish(state(), preferences.value.nativeTasks);
  library?.postMessage({ type: "snapshot", sessions: snapshot.sessions });
  for (const window of windows.values())
    if (!window.isDestroyed()) window.webContents.send("ocelin:state", state());
  if (tray)
    tray.setToolTip(
      `Ocelin · ${snapshot.counts.running} running · ${snapshot.counts.attention} need you${resources.value.status === "ready" && resources.value.memoryBytes != null && Date.now() - resources.value.sampledAt < 35000 ? ` · ${(resources.value.memoryBytes / 1024 ** 3).toFixed(1)} GB apps + tools` : ""}`,
    );
  if (project) project.worker.postMessage({ type: "snapshot", snapshot });
  const dashboard = windows.get("dashboard");
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.setOverlayIcon(
      snapshot.counts.attention ? icon() : null,
      `${snapshot.counts.attention} sessions need you`,
    );
    dashboard.setProgressBar(snapshot.counts.running ? 2 : -1);
  }
}
function libraryRequest(type, args = {}) {
  if (!library) {
    library = backgroundWorker(
      join(core, "server", "library", "worker.mjs"),
      {
        env: {
          ...process.env,
          OCELIN_DATA_DIR: dataDir,
          ...(preferences.value.sources
            ? { OCELIN_SOURCES: JSON.stringify(preferences.value.sources) }
            : {}),
        },
        name: "Ocelin session library",
      },
    );
    library.postMessage({ type: "snapshot", sessions: snapshot.sessions });
    library.on("message", (message) => {
      const pending = libraryRequests.get(message.id);
      if (!pending) return;
      libraryRequests.delete(message.id);
      clearTimeout(pending.timeout);
      message.error
        ? pending.reject(new Error(message.error))
        : pending.resolve(message.value);
    });
    library.on("exit", () => {
      library = null;
      for (const pending of libraryRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Session library stopped; try again"));
      }
      libraryRequests.clear();
    });
  }
  return new Promise((resolve, reject) => {
    const id = ++librarySequence;
    const timeout =
      type === "apply" || type === "plan"
        ? null
        : setTimeout(() => {
            libraryRequests.delete(id);
            reject(
              new Error(
                "The session library is still indexing. Try again shortly.",
              ),
            );
          }, 60000);
    libraryRequests.set(id, { resolve, reject, timeout });
    library.postMessage({ id, type, args });
  });
}
async function openSession(key) {
  const session =
    snapshot.sessions.find((s) => s.key === key) ||
    (await libraryRequest("target", { key }));
  const url = sessionLink(session);
  if (process.argv.includes("--smoke-test") && process.env.OCELIN_DATA_DIR)
    return { url };
  try {
    await shell.openExternal(url);
  } catch {
    throw new Error(
      `Windows could not open ${session.provider === "codex" ? "Codex" : "Claude"}. Install its Desktop app and try again.`,
    );
  }
  return { opened: true, provider: session.provider };
}
async function activate(args) {
  const route = args.map(activation).find(Boolean);
  if (route?.type === "session") {
    try {
      await openSession(route.key);
      return;
    } catch (e) {
      error = e.message;
      publish();
    }
  }
  showWindow("dashboard");
}
async function refreshConnections() {
  const { detectProviderApps } = require("./lib/provider-apps.cjs");
  const installed = await detectProviderApps();
  for (const provider of ["codex", "claude"]) {
    let owned = [];
    let configured = [];
    try {
      owned = JSON.parse(
        readFileSync(
          join(dataDir, "hooks", `${provider}-ownership.json`),
          "utf8",
        ),
      );
    } catch {}
    try {
      const config = JSON.parse(
        readFileSync(
          join(
            integrations.homes[provider],
            provider === "codex" ? "hooks.json" : "settings.json",
          ),
          "utf8",
        ),
      );
      configured = Object.values(config.hooks || {}).flatMap((groups) =>
        Array.isArray(groups)
          ? groups.flatMap((g) => (g.hooks || []).map((h) => h.command))
          : [],
      );
    } catch {}
    connections[provider] = {
      nativeOpen: Boolean(
        installed[provider] ||
        app.getApplicationNameForProtocol(`${provider}://`),
      ),
      hooksInstalled: owned.some((command) => configured.includes(command)),
      lastHookAt:
        snapshot.diagnostics.find((d) => d.provider === provider)?.lastHookAt ||
        0,
    };
  }
  publish();
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
  monitor = backgroundWorker(
    join(core, "server", "monitor", "worker.mjs"),
    {
      env: {
        ...process.env,
        OCELIN_DATA_DIR: dataDir,
        ...(preferences.value.sources
          ? { OCELIN_SOURCES: JSON.stringify(preferences.value.sources) }
          : {}),
      },
      name: "Ocelin session monitor",
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
        openSession(s.key).catch((e) => {
          error = e.message;
          showWindow("dashboard");
          publish();
        });
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
function backgroundWorker(file, options) {
  const worker = new Worker(file, { ...options, stdout: true, stderr: true });
  worker.kill = () => { void worker.terminate(); };
  worker.on("error", failure => { error = `${options.name}: ${failure.message}`; publish(); });
  return worker;
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
    minWidth: kind === "bar" ? 280 : 320,
    minHeight: kind === "bar" ? 62 : 360,
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
  window.once("closed", () => { if (windows.get(kind) === window) windows.delete(kind); });
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
      hideWindow(window);
    else showWindow("dashboard");
  });
  if (kind === "tray") window.on("blur", () => hideWindow(window));
  return window;
}
function hideWindow(window) {
  if (!window || window.isDestroyed()) return;
  window.ocelinVisible = false;
  window.hide();
  clearTimeout(window.ocelinSleep);
  window.ocelinSleep = setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) window.destroy();
  }, 30000);
  window.ocelinSleep.unref();
}
function showWindow(kind, focus = true) {
  const window = windows.get(kind) || createWindow(kind);
  clearTimeout(window.ocelinSleep);
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
      panel?.isVisible() ? hideWindow(panel) : showWindow("tray");
    });
    tray.on("double-click", () => showWindow("dashboard"));
  } else if (!preferences.value.tray && tray) {
    tray.destroy();
    tray = null;
    hideWindow(windows.get("tray"));
  }
  for (const kind of ["bar", "dashboard"]) {
    if (preferences.value[kind]) showWindow(kind, false);
    else hideWindow(windows.get(kind));
  }
  for (const kind of ["bar", "tray"])
    windows.get(kind)?.setAlwaysOnTop(preferences.value.alwaysOnTop);
  placeBar();
  nativeTheme.themeSource = preferences.value.theme;
  monitor?.postMessage({ type: "preferences", value: preferences.value });
  publish();
}
function placeBar() {
  const bar = windows.get("bar");
  if (!bar) return;
  const p = preferences.value;
  if (bar.ocelinLayout !== p.barLayout) {
    const area = screen.getDisplayMatching(bar.getBounds()).workArea;
    bar.setSize(
      Math.min(p.barLayout === "summary" ? 340 : 860, area.width),
      p.barLayout === "summary" ? 64 : 76,
    );
    bar.setBounds(
      recoverBounds(bar.getBounds(), screen.getAllDisplays(), bar.getBounds()),
    );
    bar.ocelinLayout = p.barLayout;
  }
  if (p.barPlacement === "taskbar") {
    const area = screen.getDisplayMatching(bar.getBounds()).workArea;
    const bounds = bar.getBounds();
    bar.setBounds({
      x: area.x + 10,
      y: area.y + area.height - bounds.height - 8,
      width: Math.min(bounds.width, area.width - 20),
      height: bounds.height,
    });
    bar.setMovable(false);
  } else bar.setMovable(true);
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
  if (!old.window.isDestroyed()) old.window.destroy();
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
  window.once("closed", () => {
    if (project?.window === window) void closeProject();
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      hideWindow(window);
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
  if (name === "install-widget") {
    const destination = join(dataDir, "integrations", "Ocelin.twidget");
    mkdirSync(join(dataDir, "integrations"), { recursive: true });
    await writeFile(destination, readFileSync(join(__dirname, "integrations", "Ocelin.twidget")));
    const roots = [join(process.env.LOCALAPPDATA || "", "Programs", "TaskbarWidgets"), join(process.env.LOCALAPPDATA || "", "TaskbarWidgets"), join(process.env.ProgramFiles || "", "TaskbarWidgets")];
    const host = roots.map(root => join(root, "TaskbarWidgets.exe")).find(existsSync);
    if (host) {
      const child = spawn(host, ["--install-widget", destination], { windowsHide: true, detached: true, stdio: "ignore" });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      return true;
    }
    const failure = await shell.openPath(destination);
    if (failure) throw new Error("Install Taskbar Widgets first, then use Connect taskbar strip to review the Ocelin package.");
    return true;
  }
  if (name === "session-open") return openSession(args.key);
  if (name === "session-preview") return libraryRequest("preview", { key: args.key, hint: snapshot.sessions.find(s => s.key === args.key) });
  if (name === "library-query") return libraryRequest("query", args);
  if (name === "library-plan") return libraryRequest("plan", args);
  if (name === "library-apply") {
    const result = await libraryRequest("apply", args);
    hiddenKeys = new Set(result.hiddenKeys);
    publish();
    return result;
  }
  if (name === "connections") {
    await refreshConnections();
    return connections;
  }
  if (name === "taskbar-guide") {
    await shell.openExternal(
      "https://github.com/m-sanchez/clawdeck/blob/main/desktop/integrations/taskbar-widgets/README.md",
    );
    return true;
  }
  if (name === "export-widget") {
    const selected = await dialog.showSaveDialog({
      title: "Save Ocelin taskbar widget",
      defaultPath: "Ocelin.twidget",
      filters: [{ name: "Taskbar Widgets package", extensions: ["twidget"] }],
    });
    if (selected.canceled) return false;
    await writeFile(
      selected.filePath,
      readFileSync(join(__dirname, "integrations", "Ocelin.twidget")),
    );
    return true;
  }
  if (name === "preferences") {
    const previousStartup = preferences.value.startup;
    const previousNative = preferences.value.nativeTasks;
    preferences.update(args);
    if (!previousNative && preferences.value.nativeTasks)
      nativeTasks.lastLaunch = 0;
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
      hideWindow(window);
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
    library?.postMessage({ type: "stop" });
    publish();
    return true;
  }
  if (name === "hook-preview")
    return integrations.preview(args.provider, args.remove === true);
  if (name === "hook-apply") {
    const result = await integrations.apply(args.id);
    await refreshConnections();
    return result;
  }
  if (name === "quit") {
    app.quit();
    return true;
  }
  throw new Error("Unknown Ocelin action");
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    void activate(argv);
  });
  app.on("window-all-closed", () => {});
  app.on("activate", () => showWindow("dashboard"));
  app.on("before-quit", () => {
    quitting = true;
    resources.stop();
    globalShortcut.unregisterAll();
    taskbarBridge.publish(state(), false);
    nativeTasks.publish(state(), false);
    monitor?.postMessage({ type: "stop" });
    library?.postMessage({ type: "stop" });
    if (project) project.worker.postMessage({ type: "stop" });
    setTimeout(() => {
      monitor?.kill();
      library?.kill();
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
        if (route.startsWith("/vendor/")) {
          const name = route.slice("/vendor/".length);
          if (
            !["codex-dark.png", "codex-light.png", "claude.svg"].includes(name)
          )
            return new Response("Not found", { status: 404 });
          return net.fetch(
            pathToFileURL(join(__dirname, "renderer", "vendor", name)).href,
          );
        }
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
      try {
        hiddenKeys = new Set(
          Object.keys(
            JSON.parse(
              readFileSync(join(dataDir, "library-hidden.json"), "utf8"),
            ),
          ),
        );
      } catch {}
      if (app.isPackaged) {
        app.setAsDefaultProtocolClient("ocelin");
        app.setJumpList([
          {
            type: "tasks",
            items: [
              {
                type: "task",
                title: "Open Ocelin",
                description: "Codex and Claude sessions",
                program: process.execPath,
                args: "ocelin://dashboard",
                iconPath: process.execPath,
                iconIndex: 0,
              },
            ],
          },
        ]);
      }
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
      resources.start();
      applySurfaces();
      await refreshConnections();
      globalShortcut.register("CommandOrControl+Alt+O", () =>
        showWindow("tray"),
      );
      if (process.argv.some((value) => activation(value)))
        void activate(process.argv);
      if (
        process.argv.includes("--background") &&
        (preferences.value.tray || preferences.value.bar)
      )
        hideWindow(windows.get("dashboard"));
      const recover = () => {
        for (const w of windows.values())
          w.setBounds(
            recoverBounds(
              w.getBounds(),
              screen.getAllDisplays(),
              w.getBounds(),
            ),
          );
        placeBar();
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
