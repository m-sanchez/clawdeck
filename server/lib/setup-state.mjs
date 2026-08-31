// @ts-check
/**
 * First-run state for the setup wizard. Tracked per install under the panel's
 * runtime dir (not per-browser), so clearing browser storage never re-triggers it
 * and a configured machine stays quiet. Only completed/skipped flags are stored.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const WIZARD_VERSION = 1;

export function setupStatePath(runtimeDir) {
  return join(runtimeDir, "setup-state.json");
}

/**
 * Read the wizard state. `firstRun` is true until the user finishes OR skips,
 * which is the only signal the client uses to auto-open the wizard.
 */
export function readSetupState(runtimeDir) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(setupStatePath(runtimeDir), "utf8"));
  } catch {
    raw = {};
  }
  const completed = Boolean(raw.completed);
  const skipped = Boolean(raw.skipped);
  return {
    firstRun: !completed && !skipped,
    completed,
    skipped,
    completedAt: raw.completedAt ?? null,
    skippedAt: raw.skippedAt ?? null,
    version: raw.version ?? null,
  };
}

/**
 * Record that the user finished or dismissed the wizard. Idempotent and additive:
 * a later "completed" keeps an earlier "skipped" timestamp, and vice versa.
 * @param {string} runtimeDir
 * @param {"completed"|"skipped"} status
 */
export function markSetup(runtimeDir, status, now = new Date().toISOString()) {
  if (status !== "completed" && status !== "skipped")
    throw new Error(`Invalid setup status: ${status}`);
  const cur = readSetupState(runtimeDir);
  const next = {
    completed: status === "completed" ? true : cur.completed,
    skipped: status === "skipped" ? true : cur.skipped,
    completedAt: status === "completed" ? now : cur.completedAt,
    skippedAt: status === "skipped" ? now : cur.skippedAt,
    version: WIZARD_VERSION,
  };
  try {
    mkdirSync(runtimeDir, { recursive: true });
  } catch {
    /* dir may already exist */
  }
  const path = setupStatePath(runtimeDir);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, path);
  return readSetupState(runtimeDir);
}
