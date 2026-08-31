import { join, resolve } from "node:path";
import { readJson } from "./files.mjs";

export async function loadPanelConfig(context) {
  const configPath = join(context.panelRoot, "panel.config.json");
  const config = await readJson(configPath);
  if (config?.schemaVersion !== 1)
    throw new Error(`Unsupported panel config: ${configPath}`);
  if (!Array.isArray(config.services) || config.services.length === 0)
    throw new Error("Panel config has no services");
  if (!config.services.some((service) => service.id === config.primaryService))
    throw new Error("primaryService is not present in services");
  return { config, configPath };
}

export function resolveRuntimeDir(context, config) {
  return resolve(context.checkoutRoot, config.runtimeRoot, context.checkoutId);
}
