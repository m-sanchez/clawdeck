const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");

const widgetId = "uk.co.miguelsanchez.ocelin";
const version = "0.6.1";

function extract(source, name) {
  const code = source.match(
    new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"),
  )?.[0];
  assert.ok(code, `Missing patched Settings function: ${name}`);
  return code;
}

async function simulate(source, options = {}) {
  const calls = [];
  const saved = [];
  const timers = [];
  let readCount = 0;
  let click;
  const optionalGrants = options.optionalGrants ?? ["user-selected-optional"];
  const builtin = {
    id: "codex-status", design: "codex-status", enabled: false,
    moveX: 0, positionPct: 100, order: 0, settings: {},
  };
  const catalogEntry = {
    id: widgetId, version, valid: true, renderer: "native",
    displayName: "Ocelin", settings: [],
  };
  const context = vm.createContext({
    locallyEditedWidgetPositions: new Set(),
    widgetCatalog: [{ id: "codex-status" }],
    defaultWidgets: [structuredClone(builtin)],
    defaults: {
      activeDesign: "codex-status", rotationDesigns: ["codex-status"], enabled: false,
    },
    state: {
      installPreview: {
        id: widgetId, version, reviewToken: "user-reviewed-token",
        isUpdate: Boolean(options.update),
      },
      installEnable: options.enable ?? true,
      installOptionalGrants: [...optionalGrants],
      settings: {
        activeDesign: "codex-status", rotationDesigns: ["codex-status"],
        enabled: false, widgets: [structuredClone(builtin)],
      },
    },
    document: {
      querySelectorAll: () => [],
      getElementById: (id) => id === "confirm-widget-install" ? {
        addEventListener: (name, handler) => {
          assert.equal(name, "click");
          click = handler;
        },
      } : null,
    },
    invoke: async (name, args) => {
      calls.push([name, args]);
      if (name === "install_community_widget") {
        assert.deepEqual(JSON.parse(JSON.stringify(args)), {
          reviewToken: "user-reviewed-token",
          grantedOptionalPermissions: optionalGrants,
          replaceExisting: Boolean(options.update),
        });
        if (options.installFailure) throw new Error("Review rejected");
        return widgetId;
      }
      if (name === "control_runtime") {
        assert.ok(["load", "unload"].includes(args.action));
        if (args.action === "load" && options.loadFailure) {
          throw new Error("Runtime unavailable");
        }
        return {};
      }
      if (name === "save_settings") {
        if (options.saveFailure) throw new Error("Access denied while saving settings");
        saved.push(JSON.parse(JSON.stringify(args.settings)));
        return;
      }
      assert.equal(name, "load_state");
      readCount++;
      assert.ok(readCount <= 20, "Catalog polling must remain bounded");
      assert.equal(context.state.settings.widgets[0].enabled, false);
      let widgets = [];
      if (options.invalid) {
        widgets = [{ ...catalogEntry, valid: false, error: "Package approval does not match current content" }];
      } else if (!options.never) {
        if (readCount > 3) widgets = [catalogEntry];
        else if (options.stale) widgets = [{ ...catalogEntry, version: "0.6.0" }];
        else if (options.wrongId) widgets = [{ ...catalogEntry, id: "other.example.widget" }];
      }
      return { widgetCatalog: { widgets } };
    },
    setTimeout: (callback, milliseconds) => {
      assert.equal(milliseconds, 500);
      timers.push(Promise.resolve().then(callback));
      return timers.length;
    },
    setDirty: (dirty) => { context.state.dirty = dirty; },
    setStatus: (status) => { context.state.status = status; },
    render() {},
    renderInstallModal() {},
  });
  for (const name of [
    "widgetById", "isKnownWidget", "applyRuntimeCatalog", "mergeSettings",
    "normalizeWidgets", "normalizeRotation", "widgetState", "activeWidget", "clampNumber",
    "closeInstallModal", "waitForInstalledWidget", "bindInstallModal",
    "saveSettings",
  ]) {
    vm.runInContext(extract(source, name), context);
  }
  vm.runInContext("bindInstallModal()", context);
  assert.equal(typeof click, "function");
  await click({ currentTarget: { disabled: false } });
  await Promise.all(timers);
  return { state: context.state, calls, saved, reads: readCount, waits: timers.length };
}

async function main() {
  assert.equal(process.argv.length, 3, "Usage: node scripts/taskbar-host-smoke.cjs <patched-upstream-directory>");
  const file = resolve(process.argv[2], "src/settings/dist/app.js");
  const source = readFileSync(file, "utf8");
  new vm.Script(source, { filename: file });

  for (const options of [
    {}, { enable: false }, { optionalGrants: [] },
    { stale: true }, { wrongId: true }, { update: true },
  ]) {
    const result = await simulate(source, options);
    assert.equal(result.reads, 4);
    assert.equal(result.saved.length, 1);
    assert.equal(result.saved[0].widgets.find((widget) => widget.design === "codex-status").enabled, false);
    const installed = result.saved[0].widgets.find((widget) => widget.design === widgetId);
    assert.equal(installed.enabled, options.enable ?? true);
    assert.equal(installed.settings._permissionsApproved, true);
    assert.equal(result.saved[0].activeDesign, widgetId);
    const loadIndex = result.calls.findIndex(([name, args]) => name === "control_runtime" && args.action === "load");
    const installIndex = result.calls.findIndex(([name]) => name === "install_community_widget");
    assert.ok(loadIndex > installIndex);
    assert.ok(loadIndex < result.calls.findIndex(([name]) => name === "load_state"));
    assert.equal(result.calls.some(([name, args]) => name === "control_runtime" && args.action === "unload"), Boolean(options.update));
  }
  for (const options of [{ never: true }, { invalid: true }, { loadFailure: true }]) {
    const result = await simulate(source, options);
    assert.equal(result.saved.length, 0);
    assert.equal(result.state.settings.widgets[0].enabled, false);
    assert.equal(result.state.settings.widgets.some((widget) => widget.settings._permissionsApproved), false);
    assert.equal(result.reads, options.loadFailure ? 0 : 20);
    assert.equal(result.waits, options.loadFailure ? 0 : 19);
    assert.match(result.state.status, /Installed .*setup could not finish/);
    assert.match(result.state.status, /Open Settings, load the runtime, then enable the installed widget in the library/);
    if (options.invalid) assert.match(result.state.status, /Package approval does not match/);
  }
  for (const options of [{}, { enable: false }, { update: true }]) {
    const result = await simulate(source, { ...options, saveFailure: true });
    assert.equal(result.saved.length, 0);
    assert.equal(result.calls.filter(([name]) => name === "save_settings").length, 1);
    assert.equal(result.state.settings.widgets[0].enabled, false);
    assert.equal(result.state.dirty, true);
    assert.match(result.state.status, /Installed .*setup could not finish/);
    assert.match(result.state.status, /Save failed: Error: Access denied while saving settings/);
    assert.match(result.state.status, /Open Settings, load the runtime, then enable the installed widget in the library/);
    assert.doesNotMatch(result.state.status, /installed and enabled|updated to/);
  }
  const rejected = await simulate(source, { installFailure: true });
  assert.equal(rejected.saved.length, 0);
  assert.equal(rejected.calls.some(([name]) => name === "control_runtime"), false);
  assert.match(rejected.state.installError, /Review rejected/);
  const failedUpdate = await simulate(source, { update: true, installFailure: true });
  assert.deepEqual(
    failedUpdate.calls.filter(([name]) => name === "control_runtime").map(([, args]) => args.action),
    ["unload", "load"],
  );
  console.log("Taskbar host smoke passed: exact catalog identity, disabled choice, approval arguments, save failures, bounded failures and runtime recovery; all external actions mocked.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
