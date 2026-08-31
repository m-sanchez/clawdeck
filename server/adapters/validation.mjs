// @ts-check
/**
 * Validation adapter. The repository's deterministic gate is
 * `.claude/scripts/worktree-verify.mjs --json` (tsc / eslint / prettier / jest
 * over the change set). Running it mutates nothing but needs the node_modules
 * junction, so it is an explicit allowlisted action (see actions.mjs); this
 * adapter only *reads* the most recent cached report for the snapshot.
 *
 * @typedef {import('../../../contracts/panel-protocol').ValidationCheck} ValidationCheck
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const HISTORY_CAP = 20;

export function validationHistoryPath(runtimeDir, slug = "current") {
  const safe =
    String(slug || "current").replace(/[^a-zA-Z0-9._-]+/g, "-") || "current";
  return join(runtimeDir, `validation-history-${safe}.json`);
}

/** Last N validation outcomes for a slug, oldest first. Best-effort. */
export function getValidationHistory(runtimeDir, slug = "current") {
  const p = validationHistoryPath(runtimeDir, slug);
  if (!existsSync(p)) return [];
  try {
    const arr = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(arr) ? arr.slice(-HISTORY_CAP) : [];
  } catch {
    return [];
  }
}

/** Append one outcome record, capped and written atomically. Best-effort. */
export function appendValidationHistory(runtimeDir, slug, record) {
  const p = validationHistoryPath(runtimeDir, slug);
  const arr = getValidationHistory(runtimeDir, slug);
  arr.push(record);
  try {
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(arr.slice(-HISTORY_CAP)));
    renameSync(tmp, p);
  } catch {
    /* history is non-critical */
  }
}

/** @type {Record<string, ValidationCheck['status']>} */
const STATUS_MAP = {
  pass: "passed",
  fail: "failed",
  "skipped-no-jest": "skipped",
  skipped: "skipped",
  running: "running",
};

export function validationReportPath(runtimeDir, slug = "current") {
  const safe =
    String(slug || "current").replace(/[^a-zA-Z0-9._-]+/g, "-") || "current";
  return join(runtimeDir, `validation-${safe}.json`);
}

/**
 * @param {{ runtimeDir: string }} ctx
 * @param {string} [slug]
 * @returns {{ status: 'none'|'ok'|'stale', ranAt: string|null, base: string|null, checks: ValidationCheck[], passed: boolean, history?: any[] }}
 */
export function getValidation(ctx, slug = "current") {
  const path = validationReportPath(ctx.runtimeDir, slug);
  if (!existsSync(path)) {
    return {
      status: "none",
      ranAt: null,
      base: null,
      checks: [],
      passed: false,
    };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {
      status: "none",
      ranAt: null,
      base: null,
      checks: [],
      passed: false,
    };
  }

  /** @type {ValidationCheck[]} */
  const checks = (report.report ?? []).map((row, i) => ({
    id: `${row.proj}:${row.check}:${i}`,
    label: `${row.check}`,
    project: row.proj,
    status: STATUS_MAP[row.status] ?? "queued",
    blocking: row.check !== "jest" ? true : true,
    command: row.command,
    durationMs: row.durationMs,
    summary:
      typeof row.detail === "string"
        ? row.detail
        : Array.isArray(row.detail)
          ? row.detail.join(", ")
          : undefined,
  }));

  // A non-zero exit / ok:false means worktree-verify itself FAILED (crash, missing
  // deps, unresolved base), materially different from a clean run with no
  // applicable checks. Surface it as a blocking failed check so it is never
  // mistaken for "no scope" and never reads as push-ready.
  const executionFailed =
    report.ok === false ||
    (typeof report.exitCode === "number" && report.exitCode !== 0);
  if (executionFailed && !checks.some((c) => c.status === "failed")) {
    checks.unshift({
      id: "verify:execution",
      label: "verify execution",
      project: "(runner)",
      status: "failed",
      blocking: true,
      summary:
        report.reason ||
        `worktree-verify exited ${report.exitCode ?? "non-zero"}.`,
    });
  }

  const passed =
    checks.length > 0 &&
    checks.every((c) => c.status === "passed" || c.status === "skipped");
  return {
    status: "ok",
    ranAt: report.ranAt ?? null,
    base: report.base ?? null,
    checks,
    passed,
    history: getValidationHistory(ctx.runtimeDir, slug),
  };
}
