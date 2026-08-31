#!/usr/bin/env node
import { join } from "node:path";
import { resolvePanelContext } from "./lib/context.mjs";
import { loadPanelConfig, resolveRuntimeDir } from "./lib/config.mjs";
import { readJson, safeRemove } from "./lib/files.mjs";
import { isProcessAlive, stopProcessTree } from "./lib/processes.mjs";
import { ownsService } from "./lib/health.mjs";

const context = resolvePanelContext();
const { config } = await loadPanelConfig(context);
const runtimeDir = resolveRuntimeDir(context, config);
const registryPath = join(runtimeDir, "registry.json");
const registry = await readJson(registryPath, null);

if (!registry?.services?.length) {
  console.log("Clawdeck is not registered for this checkout.");
  process.exit(0);
}

// Only terminate a PID we can PROVE is still our panel (matching ownership nonce
// via /health). A reused PID, or a different process on the port, is left alone.
let unproven = false;
for (const service of registry.services) {
  if (!isProcessAlive(service.pid)) {
    console.log(`${service.id}: not running`);
    continue;
  }
  if (await ownsService(service)) {
    const result = stopProcessTree(service.pid);
    console.log(`${service.id}: ${result.stopped ? "stopped" : result.reason}`);
  } else {
    unproven = true;
    console.log(
      `${service.id}: pid ${service.pid} alive but ownership unproven (nonce mismatch) — left untouched`,
    );
  }
}
if (unproven) {
  console.log(
    "Stale registry kept for inspection (an unproven process was not killed).",
  );
} else {
  await safeRemove(registryPath);
}
console.log(`Runtime logs retained at ${runtimeDir}`);
