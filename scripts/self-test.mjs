#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePanelContext } from "./lib/context.mjs";
import { isPortAvailable } from "./lib/ports.mjs";
import { waitForHealth } from "./lib/health.mjs";
import { stopProcessTree } from "./lib/processes.mjs";

const context = resolvePanelContext();
const required = [
  "README.md",
  "ARCHITECTURE.md",
  "panel.config.json",
  "reference/clawd-playground-v16.html",
  "server/start.mjs",
  "ui/index.html",
  "hooks/emit-event.cjs",
  "hooks/lib/event-spool.cjs",
  "hooks/lib/event-normalize.cjs",
];

for (const relative of required) {
  const path = join(context.panelRoot, relative);
  if (!existsSync(path))
    throw new Error(`Required package file missing: ${relative}`);
}

const config = JSON.parse(
  await readFile(join(context.panelRoot, "panel.config.json"), "utf8"),
);
if (
  config.schemaVersion !== 1 ||
  !Array.isArray(config.services) ||
  config.services.length === 0
) {
  throw new Error("panel.config.json is invalid");
}

const clawd = await readFile(
  join(context.panelRoot, "reference", "clawd-playground-v16.html"),
  "utf8",
);
for (const state of [
  "sleeping",
  "thinking",
  "idle",
  "reading",
  "working",
  "validating",
  "reviewing",
  "waiting",
  "attention",
  "blocked",
  "success",
]) {
  if (
    !clawd.includes(`data-state="${state}"`) &&
    !clawd.includes(`'${state}'`)
  ) {
    throw new Error(
      `Canonical Clawd reference does not contain state: ${state}`,
    );
  }
}

let port = 49870;
while (!(await isPortAvailable(port))) port += 1;
const child = spawn(
  process.execPath,
  [join(context.panelRoot, "server", "start.mjs")],
  {
    cwd: context.checkoutRoot,
    env: {
      ...process.env,
      PANEL_SERVICE_PORT: String(port),
      PANEL_CHECKOUT_ID: "self-test",
      PANEL_CHECKOUT_ROOT: context.checkoutRoot,
      PANEL_REPO_ROOT: context.repoRoot,
      PANEL_RUNTIME_DIR: join(
        context.checkoutRoot,
        ".claude",
        ".runtime",
        "self-test",
      ),
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  },
);
child.unref();

try {
  const healthy = await waitForHealth(`http://127.0.0.1:${port}/health`, {
    timeoutMs: 7000,
  });
  if (!healthy) throw new Error("Starter server did not become healthy");
} finally {
  stopProcessTree(child.pid);
}

console.log("Clawdeck package self-test passed.");
