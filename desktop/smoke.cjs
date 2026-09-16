const assert = require("node:assert/strict");
const { writeFileSync, mkdirSync } = require("node:fs");
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
    const keys = getState().sessions.map((s) => s.key);
    assert.ok(
      keys.some((k) => k.startsWith("codex:")) &&
        keys.some((k) => k.startsWith("claude:")),
    );
    report.checks.push("Codex and concurrent Claude sessions discovered");
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
    const rejected = await dashboard.webContents.executeJavaScript(
      "window.ocelin.action('project',{key:'unknown'}).then(()=>false,()=>true)",
    );
    assert.equal(rejected, true);
    report.checks.push("Unknown session target rejected through renderer IPC");
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
  }
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
};
