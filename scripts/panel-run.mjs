#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvePanelContext } from "./lib/context.mjs";
import { loadPanelConfig, resolveRuntimeDir } from "./lib/config.mjs";
import { ensureDir, readJson, writeJsonAtomic } from "./lib/files.mjs";
import { allocatePorts } from "./lib/ports.mjs";
import { isProcessAlive, stopProcessTree } from "./lib/processes.mjs";
import { waitForHealth, ownsService } from "./lib/health.mjs";
import { openBrowser } from "./lib/browser.mjs";

const args = new Set(process.argv.slice(2));
const shouldOpen = !args.has("--no-open");
const restart = args.has("--restart");
const context = resolvePanelContext();
const { config } = await loadPanelConfig(context);
const runtimeDir = resolveRuntimeDir(context, config);
const registryPath = join(runtimeDir, "registry.json");
const launchNonce = randomBytes(12).toString("hex");
await ensureDir(runtimeDir);

/**
 * The dashboard URL carrying the per-launch token in the FRAGMENT. A fragment is
 * never sent to the server and never lands in a Referer, so this string is safe
 * to hand to a browser but must never be written to the registry or a log file.
 */
function dashboardUrl(url) {
  try {
    const token = readFileSync(join(runtimeDir, "panel.token"), "utf8").trim();
    return token ? `${url}#token=${token}` : url;
  } catch {
    return url; // no token yet: the UI will report that one is required
  }
}

async function registryIsHealthy(registry) {
  if (!registry?.services?.length) return false;
  for (const service of registry.services) {
    if (!isProcessAlive(service.pid)) return false;
    if (!(await ownsService(service))) return false;
  }
  return true;
}

/** Stop a recorded service ONLY when its ownership is proven (nonce via /health). */
async function stopOwned(service) {
  if (!isProcessAlive(service.pid)) return;
  if (await ownsService(service)) {
    stopProcessTree(service.pid);
  } else {
    console.warn(
      `Recorded pid ${service.pid} (${service.id}) is alive but does not prove panel ownership; leaving it untouched.`,
    );
  }
}

const existing = await readJson(registryPath, null);
if (existing && restart) {
  for (const service of existing.services ?? []) await stopOwned(service);
}

if (existing && !restart && (await registryIsHealthy(existing))) {
  const primary =
    existing.services.find((service) => service.id === config.primaryService) ??
    existing.services[0];
  if (shouldOpen && config.browser.openByDefault !== false)
    openBrowser(dashboardUrl(primary.url));
  console.log("Clawdeck is already healthy.");
  console.log(`Dashboard: ${dashboardUrl(primary.url)}`);
  console.log(`Checkout: ${context.checkoutRoot}`);
  console.log(`Runtime: ${runtimeDir}`);
  process.exit(0);
}

if (existing) {
  for (const service of existing.services ?? []) await stopOwned(service);
}

const ports = await allocatePorts({
  checkoutId: context.checkoutId,
  count: config.services.length,
  preferredBase: config.ports.preferredBase,
  searchSpan: config.ports.searchSpan,
});

const started = [];
try {
  for (let index = 0; index < config.services.length; index += 1) {
    const service = config.services[index];
    const port = ports[index];
    const entry = resolve(context.panelRoot, service.entry);
    if (!existsSync(entry))
      throw new Error(`Service entry does not exist: ${entry}`);

    const cwd = resolve(context.checkoutRoot, service.cwd ?? ".");
    const logPath = join(runtimeDir, `${service.id}.log`);
    const outputFd = openSync(logPath, "a");
    const env = {
      ...process.env,
      PANEL_SERVICE_ID: service.id,
      PANEL_SERVICE_PORT: String(port),
      PANEL_CHECKOUT_ID: context.checkoutId,
      PANEL_CHECKOUT_ROOT: context.checkoutRoot,
      PANEL_REPO_ROOT: context.repoRoot,
      PANEL_RUNTIME_DIR: runtimeDir,
      PANEL_NONCE: launchNonce,
    };
    if (service.portEnv) env[service.portEnv] = String(port);

    const child = spawn(process.execPath, [entry, ...(service.args ?? [])], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", outputFd, outputFd],
      windowsHide: true,
    });
    closeSync(outputFd);
    child.unref();

    const healthPath = service.healthPath.startsWith("/")
      ? service.healthPath
      : `/${service.healthPath}`;
    const urlPath = (service.urlPath ?? "/").startsWith("/")
      ? (service.urlPath ?? "/")
      : `/${service.urlPath}`;
    const base = `http://127.0.0.1:${port}`;
    const runtime = {
      id: service.id,
      label: service.label,
      pid: child.pid,
      nonce: launchNonce,
      port,
      url: `${base}${urlPath}`,
      healthUrl: `${base}${healthPath}`,
      logPath,
      startedAt: new Date().toISOString(),
    };
    started.push(runtime);
  }

  for (const service of started) {
    const healthy = await waitForHealth(service.healthUrl, {
      timeoutMs: 25000,
    });
    if (!healthy)
      throw new Error(
        `Health check failed for ${service.id}: ${service.healthUrl}`,
      );
  }

  const registry = {
    schemaVersion: 1,
    checkoutId: context.checkoutId,
    checkoutRoot: context.checkoutRoot,
    repoRoot: context.repoRoot,
    branch: context.branch,
    runtimeDir,
    services: started,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(registryPath, registry);

  const primary =
    started.find((service) => service.id === config.primaryService) ??
    started[0];
  // The token only exists once the server has booted, so compose the URL after
  // the health wait above. The registry keeps the plain URL: it is a shared file.
  const entryUrl = dashboardUrl(primary.url);
  if (shouldOpen && config.browser.openByDefault !== false) {
    const browser = openBrowser(entryUrl);
    if (!browser.opened)
      console.warn(
        `Panel started, but the browser could not be opened automatically: ${browser.error}`,
      );
  }

  console.log("Clawdeck started.");
  console.log(`Dashboard: ${entryUrl}`);
  console.log(`Checkout: ${context.checkoutRoot}`);
  console.log(`Branch: ${context.branch ?? "(detached)"}`);
  console.log(`Runtime: ${runtimeDir}`);
  for (const service of started)
    console.log(
      `- ${service.id}: pid=${service.pid} port=${service.port} log=${service.logPath}`,
    );
} catch (error) {
  for (const service of started) stopProcessTree(service.pid);
  console.error(error?.stack ?? error);
  process.exit(1);
}
