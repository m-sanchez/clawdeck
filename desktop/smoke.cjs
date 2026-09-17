const assert = require("node:assert/strict");
const {
  writeFileSync,
  mkdirSync,
  renameSync,
  realpathSync,
} = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

module.exports = async function smoke({
  app,
  windows,
  action,
  getState,
  getProject,
  dataDir,
  core,
}) {
  const until = async (test, label) => {
    for (let n = 0; n < 150; n++) {
      if (await test()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const output = join(dataDir, "proof");
  mkdirSync(output, { recursive: true });
  const report = {
    version: app.getVersion(),
    packaged: app.isPackaged,
    checks: [],
  };
  try {
    await until(() => getState().sessions.length >= 3, "fixture sessions");
    assert.equal(realpathSync(process.cwd()), realpathSync(dataDir));
    const launchDir = join(dataDir, "..", "widget-launch");
    renameSync(launchDir, `${launchDir}-released`);
    renameSync(`${launchDir}-released`, launchDir);
    report.checks.push(
      "App and helpers release the widget launch directory before monitoring starts",
    );
    const keys = getState().sessions.map((s) => s.key);
    assert.ok(
      keys.some((k) => k.startsWith("codex:")) &&
        keys.some((k) => k.startsWith("claude:")),
    );
    report.checks.push("Codex and concurrent Claude sessions discovered");
    if (process.argv.includes("--background")) {
      const initial = windows.get("dashboard");
      await until(
        () => !initial.webContents.isLoading(),
        "initial dashboard loaded",
      );
      const p = getState().preferences;
      await until(
        () => initial.isVisible() === !(p.tray || p.bar),
        "background visibility",
      );
      assert.equal(initial.ocelinVisible, !(p.tray || p.bar));
      report.checks.push(
        "Background startup preserves the chosen recovery surface",
      );
    }
    const { Integrations } = await import(
      pathToFileURL(join(core, "server/monitor/integrations.mjs")).href
    );
    const integration = new Integrations({
      dataDir,
      runtime: process.execPath,
      captureFile: join(core, "hooks/ocelin-capture.cjs"),
      homes: { claude: join(dataDir, "fixture-provider") },
    });
    const preview = await integration.preview("claude");
    await integration.apply(preview.id);
    const command = preview.after.PermissionRequest[0].hooks[0].command;
    const capture = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        command.split(" ").at(-1),
      ],
      {
        input: JSON.stringify({
          session_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          cwd: getState().sessions.find(
            (s) => s.provider === "claude" && s.sessionId.startsWith("bbbb"),
          ).cwd,
          hook_event_name: "PermissionRequest",
          tool_input: { private: "not persisted" },
        }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 8000,
      },
    );
    assert.equal(capture.status, 0);
    await action("refresh");
    await until(
      () =>
        getState().sessions.some(
          (s) => s.attention === "permission" && s.evidence === "hook",
        ),
      "bundled hook receipt",
    );
    await integration.apply((await integration.preview("claude", true)).id);
    report.checks.push(
      "Packaged runtime captured a redacted hook and selectively removed its fixture configuration",
    );
    for (const kind of ["dashboard", "bar", "tray"]) {
      await action("show", { surface: kind });
      const window = windows.get(kind);
      await until(() => !window.webContents.isLoading(), `${kind} loaded`);
      await until(
        async () =>
          window.webContents.executeJavaScript(
            "document.querySelectorAll('#sessions .session').length > 0",
          ),
        `${kind} rows`,
      );
      const secure = await window.webContents.executeJavaScript(
        "typeof require === 'undefined' && typeof process === 'undefined' && typeof window.ocelin.action === 'function'",
      );
      assert.equal(secure, true);
      await until(
        async () =>
          window.webContents.executeJavaScript(
            "[...document.querySelectorAll('.provider-icon img')].every(i => i.complete && i.naturalWidth > 0)",
          ),
        `${kind} official provider icons`,
      );
      const layout = await window.webContents.executeJavaScript(
        "({surface:document.body.dataset.surface,width:innerWidth,scroll:document.documentElement.scrollWidth,limbs:document.querySelector('ocelin-assistant').shadowRoot.querySelectorAll('.clawd-arm,.clawd-leg').length})",
      );
      assert.equal(layout.surface, kind);
      assert.equal(layout.limbs, 4);
      assert.ok(layout.scroll <= layout.width);
      writeFileSync(
        join(output, `${kind}.png`),
        (await window.webContents.capturePage()).toPNG(),
      );
      report.checks.push(
        `${kind}: populated, sandboxed, four-limb mascot, no page overflow`,
      );
    }
    const dashboard = windows.get("dashboard");
    assert.equal(
      (await require("electron").net.fetch("ocelin://app/vendor/unknown.svg"))
        .status,
      404,
    );
    await until(
      () => getState().resources?.status === "ready",
      "Windows memory sample",
    );
    assert.ok(
      getState().resources.groups.find((g) => g.provider === "ocelin")
        .memoryBytes > 0,
    );
    const baseline = await dashboard.webContents.executeJavaScript(
      "({filter:document.getElementById('filter').value,rows:document.querySelectorAll('#sessions .session').length,history:document.getElementById('counts').innerText,project:document.querySelector('.project-group').dataset.project})",
    );
    assert.equal(baseline.filter, "active");
    assert.ok(!/Discovered|In history/.test(baseline.history));
    await dashboard.webContents.executeJavaScript(
      "document.querySelector('.project-heading').click()",
    );
    await until(
      async () =>
        dashboard.webContents.executeJavaScript(
          "!document.querySelector('.project-group').open",
        ),
      "project collapsed",
    );
    await action("refresh");
    assert.equal(
      await dashboard.webContents.executeJavaScript(
        "document.querySelector('.project-group').open",
      ),
      false,
    );
    await dashboard.webContents.executeJavaScript(
      "document.querySelector('.project-heading').click()",
    );
    await action("preferences", { historySince: Date.now() });
    await dashboard.webContents.executeJavaScript(
      "document.getElementById('filter').value='all'; document.getElementById('filter').dispatchEvent(new Event('change'))",
    );
    await until(
      async () =>
        dashboard.webContents.executeJavaScript(
          "!document.getElementById('sessions').innerText.includes('Turn finished')",
        ),
      "old history hidden",
    );
    await action("preferences", { historySince: 0 });
    await dashboard.webContents.executeJavaScript(
      "document.getElementById('filter').value='active'; document.getElementById('filter').dispatchEvent(new Event('change'))",
    );
    await action("preferences", {
      bar: true,
      barLayout: "summary",
      barPlacement: "taskbar",
    });
    const bar = windows.get("bar");
    await until(
      async () =>
        bar.webContents.executeJavaScript(
          "document.body.dataset.barLayout==='summary'",
        ),
      "summary tile",
    );
    assert.equal(bar.isMovable(), true);
    assert.equal(
      await bar.webContents.executeJavaScript(
        "document.getElementById('hide').getBoundingClientRect().width > 0",
      ),
      true,
    );
    bar.emit("will-move");
    assert.equal(getState().preferences.barPlacement, "floating");
    await bar.webContents.executeJavaScript(
      "document.getElementById('hide').click()",
    );
    await until(() => !bar.isVisible(), "floating bar dismissed");
    assert.equal(getState().preferences.bar, false);
    await action("preferences", { density: "compact" });
    assert.equal(bar.isVisible(), false);
    await action("preferences", { bar: true });
    await until(() => bar.isVisible(), "floating bar restored");
    bar.close();
    assert.equal(getState().preferences.bar, false);
    await action("preferences", { bar: true });
    await until(() => bar.isVisible(), "closed floating bar restored");
    await action("hide", { surface: "dashboard" });
    assert.equal(dashboard.isVisible(), false);
    await action("hide", { surface: "bar" });
    assert.equal(dashboard.isVisible(), false);
    await action("preferences", { bar: true });
    await until(() => bar.isVisible(), "bar restored with dashboard recovery");
    report.checks.push(
      "Anchored tile is movable; dragging releases its anchor; button and window dismissal persist with recovery",
    );
    writeFileSync(
      join(output, "summary-tile.png"),
      (await bar.webContents.capturePage()).toPNG(),
    );
    await action("preferences", {
      barLayout: "sessions",
      barPlacement: "floating",
    });
    report.checks.push(
      "Live RAM, active-first view, collapse persistence, reversible history cleanup and status tile verified",
    );
    const originalBounds = dashboard.getBounds();
    await action("preferences", { theme: "light" });
    await until(
      async () =>
        dashboard.webContents.executeJavaScript(
          "getComputedStyle(document.querySelector('.provider-on-light')).display !== 'none' && getComputedStyle(document.querySelector('.provider-on-dark')).display === 'none'",
        ),
      "official light-mode Codex icon",
    );
    for (const width of [700, 420, 320]) {
      dashboard.setSize(width, 700);
      await new Promise((r) => setTimeout(r, 150));
      const layout = await dashboard.webContents.executeJavaScript(
        "({width:innerWidth,scroll:document.documentElement.scrollWidth})",
      );
      assert.ok(
        layout.scroll <= layout.width,
        `Dashboard overflow at ${width}: ${JSON.stringify(layout)}`,
      );
    }
    writeFileSync(
      join(output, "dashboard-narrow-light.png"),
      (await dashboard.webContents.capturePage()).toPNG(),
    );
    dashboard.setBounds(originalBounds);
    await action("preferences", { theme: "dark" });
    report.checks.push("Light dashboard fits 320, 420 and 700 pixel windows");
    const rejected = await dashboard.webContents.executeJavaScript(
      "window.ocelin.action('project',{key:'unknown'}).then(()=>false,()=>true)",
    );
    assert.equal(rejected, true);
    report.checks.push("Unknown session target rejected through renderer IPC");
    const libraryPage = await action("library-query", { view: "history" });
    assert.ok(libraryPage.entries.length >= 3);
    const claudeSession = libraryPage.entries.find(
      (s) => s.provider === "claude",
    );
    const peek = await action("session-preview", { key: claudeSession.key });
    assert.ok(peek.request.includes("Windows integration"));
    const link = await action("session-open", { key: claudeSession.key });
    assert.equal(
      link.url,
      `claude://resume?session=${claudeSession.sessionId}`,
    );
    await dashboard.webContents.executeJavaScript(
      "document.querySelector('[data-view=history]').click()",
    );
    await until(
      async () =>
        dashboard.webContents.executeJavaScript(
          "document.querySelectorAll('.library-row').length >= 3",
        ),
      "history rows",
    );
    await action("show", { surface: "dashboard" });
    await dashboard.webContents.executeJavaScript(
      "document.querySelector('.library-row .session-title').focus()",
    );
    await until(
      async () =>
        dashboard.webContents.executeJavaScript(
          "!document.getElementById('session-peek').hidden && document.getElementById('session-peek').textContent.includes('Latest request')",
        ),
      "zero-click transcript preview",
    );
    writeFileSync(
      join(output, "history-preview.png"),
      (await dashboard.webContents.capturePage()).toPNG(),
    );
    const hide = await action("library-plan", {
      operation: "hide",
      keys: [claudeSession.key],
    });
    await action("library-apply", { id: hide.id });
    assert.ok(
      (await action("library-query", { view: "archived" })).entries.some(
        (s) => s.key === claudeSession.key && s.hidden,
      ),
    );
    await action("library-apply", {
      id: (
        await action("library-plan", {
          operation: "unhide",
          keys: [claudeSession.key],
        })
      ).id,
    });
    await dashboard.webContents.executeJavaScript(
      "document.querySelector('[data-view=now]').click()",
    );
    report.checks.push(
      "Native URI dispatch, history, hover transcript preview, hide and restore through renderer IPC",
    );
    const selected = getState().sessions.find((s) => s.provider === "codex");
    await action("project", { key: selected.key });
    const project = getProject();
    await until(
      async () =>
        project.window.webContents.executeJavaScript(
          "document.body.innerText.includes('Session') && !document.querySelector('.wizard-overlay')",
        ),
      "project view",
    );
    assert.ok(
      project.window.webContents.getURL().includes("/activity/session"),
    );
    await until(
      async () =>
        project.window.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('select')).some(s=>s.value===${JSON.stringify(selected.key)})`,
        ),
      "selected provider and session",
    );
    const version = await (
      await require("electron").net.fetch(
        `http://127.0.0.1:${project.port}/health`,
      )
    ).json();
    assert.equal(version.nonce, project.nonce);
    report.checks.push(
      "Bundled project backend booted and correct session route opened",
    );
    project.window.destroy();
    assert.equal(getProject(), null);
    await action("project", { key: selected.key });
    assert.ok(getProject() && !getProject().window.isDestroyed());
    report.checks.push(
      "Released project window stops its backend and reopens cleanly",
    );
    for (const combo of [
      { tray: true, bar: false, dashboard: false },
      { tray: false, bar: true, dashboard: false },
      { tray: false, bar: false, dashboard: true },
      { tray: false, bar: false, dashboard: false },
    ]) {
      await action("preferences", combo);
      const p = getState().preferences;
      assert.ok(p.tray || p.bar || p.dashboard);
    }
    report.checks.push("Surface combinations retain a recovery surface");
    if (app.isPackaged) {
      const login = { path: process.execPath, args: ["--background"] };
      const original = app.getLoginItemSettings(login).openAtLogin;
      try {
        await action("preferences", { startup: true });
        assert.equal(app.getLoginItemSettings(login).openAtLogin, true);
        await action("preferences", { startup: false });
        assert.equal(app.getLoginItemSettings(login).openAtLogin, false);
        report.checks.push(
          "Sign-in startup enabled, verified, disabled and restored",
        );
      } finally {
        app.setLoginItemSettings({ ...login, openAtLogin: original });
      }
    }
    report.metrics = getState().metrics;
    app.getAppMetrics();
    await new Promise((done) => setTimeout(done, 2000));
    report.processes = app.getAppMetrics().map((m) => ({
      type: m.type,
      serviceName: m.serviceName,
      workingSetKB: m.memory.workingSetSize,
      privateKB: m.memory.privateBytes,
      cpuPercent: m.cpu.percentCPUUsage,
    }));
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = error.stack;
    const dashboard = windows.get("dashboard");
    if (dashboard && !dashboard.isDestroyed()) {
      report.ui = await dashboard.webContents
        .executeJavaScript(
          "({error:document.getElementById('error').textContent,peek:document.getElementById('session-peek').textContent,hidden:document.getElementById('session-peek').hidden,dialog:[...document.querySelectorAll('dialog[open]')].map(d=>d.id),focus:document.activeElement?.outerHTML})",
        )
        .catch(() => null);
      writeFileSync(
        join(output, "failure.png"),
        (await dashboard.webContents.capturePage()).toPNG(),
      );
    }
  }
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  app.once("will-quit", (event) => {
    event.preventDefault();
    setTimeout(() => app.exit(report.ok ? 0 : 1), 2200);
  });
  app.quit();
};
