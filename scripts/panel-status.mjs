#!/usr/bin/env node
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolvePanelContext } from "./lib/context.mjs";
import { loadPanelConfig, resolveRuntimeDir } from "./lib/config.mjs";
import { readJson } from "./lib/files.mjs";
import { isProcessAlive } from "./lib/processes.mjs";
import { isHealthy } from "./lib/health.mjs";

const context = resolvePanelContext();
const { config } = await loadPanelConfig(context);
const runtimeDir = resolveRuntimeDir(context, config);
const registry = await readJson(join(runtimeDir, "registry.json"), null);

console.log(`Checkout: ${context.checkoutRoot}`);
console.log(`Branch: ${context.branch ?? "(detached)"}`);
console.log(`Runtime: ${runtimeDir}`);

if (!registry?.services?.length) {
  console.log("Panel status: not registered");
  process.exit(1);
}

let allHealthy = true;
for (const service of registry.services) {
  const alive = isProcessAlive(service.pid);
  const healthy = alive && (await isHealthy(service.healthUrl));
  allHealthy &&= healthy;
  console.log(
    `${service.id}: ${healthy ? "healthy" : alive ? "unhealthy" : "stopped"} pid=${service.pid} port=${service.port}`,
  );
  // Printed to the terminal only, never to a file: the fragment carries the
  // per-launch token the UI needs to reach the privileged routes.
  let entry = service.url;
  try {
    const token = readFileSync(join(runtimeDir, "panel.token"), "utf8").trim();
    if (token && healthy) entry = `${service.url}#token=${token}`;
  } catch {
    /* no token file: print the plain url */
  }
  console.log(`  url: ${entry}`);
  console.log(`  log: ${service.logPath}`);
}

process.exitCode = allHealthy ? 0 : 1;
