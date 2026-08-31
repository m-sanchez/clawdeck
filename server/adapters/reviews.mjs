// @ts-check
/**
 * Reviews adapter. Reuses the repository's own pre-push review pipeline
 * (`.claude/hooks/lib/review-run.js` → `runPrePush`), the same deterministic
 * scanner that gates Claude pushes, so the panel's findings match what the hook
 * would block on.
 *
 * The scan is SYNCHRONOUS and can take seconds on a large branch diff, so it runs
 * in a child process (`review-child.cjs`) to keep the panel's event loop, and
 * therefore `/health`, responsive. Read-only: it scans the branch diff, never
 * edits.
 *
 * @typedef {import('../../../contracts/panel-protocol').ReviewFinding} ReviewFinding
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HISTORY_CAP = 20;

export function reviewHistoryPath(runtimeDir) {
  return join(runtimeDir, "review-history-current.json");
}

/** Last N review-scan outcomes for the current checkout, oldest first. Best-effort. */
export function getReviewHistory(runtimeDir) {
  const p = reviewHistoryPath(runtimeDir);
  if (!existsSync(p)) return [];
  try {
    const arr = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(arr) ? arr.slice(-HISTORY_CAP) : [];
  } catch {
    return [];
  }
}

/** Append one outcome record, capped and written atomically. Best-effort. */
export function appendReviewHistory(runtimeDir, record) {
  const p = reviewHistoryPath(runtimeDir);
  const arr = getReviewHistory(runtimeDir);
  arr.push(record);
  try {
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(arr.slice(-HISTORY_CAP)));
    renameSync(tmp, p);
  } catch {
    /* history is non-critical */
  }
}

const childScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "review-child.cjs",
);

/** @type {Record<string, ReviewFinding['severity']>} */
const SEVERITY_MAP = { block: "blocking", warn: "medium" };

function runChild(checkoutRoot) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [childScript, checkoutRoot],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 60000 },
      (error, stdout) => {
        if (error && !stdout) return resolvePromise(null);
        try {
          resolvePromise(JSON.parse(String(stdout)));
        } catch {
          resolvePromise(null);
        }
      },
    );
  });
}

/**
 * @param {{ checkoutRoot: string }} ctx
 * @returns {Promise<{ status: 'ok'|'unavailable'|'error', findings: ReviewFinding[], base: string|null, blockCount: number, warnCount: number, message?: string }>}
 */
export async function getReviews(ctx) {
  if (
    !existsSync(
      join(ctx.checkoutRoot, ".claude", "hooks", "lib", "review-run.js"),
    )
  ) {
    return {
      status: "unavailable",
      findings: [],
      base: null,
      blockCount: 0,
      warnCount: 0,
      message: "Review pipeline not present in this checkout.",
    };
  }

  const res = await runChild(ctx.checkoutRoot);
  if (!res || res.__error) {
    return {
      status: "error",
      findings: [],
      base: null,
      blockCount: 0,
      warnCount: 0,
      message: res?.__error || "Review scan failed.",
    };
  }
  if (res.__unavailable) {
    return {
      status: "unavailable",
      findings: [],
      base: null,
      blockCount: 0,
      warnCount: 0,
      message: "Review pipeline not present in this checkout.",
    };
  }
  if (!Array.isArray(res.results)) {
    return {
      status: "error",
      findings: [],
      base: res?.base?.ref ?? null,
      blockCount: res?.blockCount ?? 0,
      warnCount: res?.warnCount ?? 0,
      message: res?.scanError || "Could not determine the branch diff.",
    };
  }

  /** @type {(ReviewFinding & { ruleId?: string })[]} */
  const findings = [];
  for (const file of res.results) {
    for (const f of file.findings ?? []) {
      findings.push({
        id: `${f.ruleId}:${file.file}:${f.line}:${f.column}`,
        severity: SEVERITY_MAP[f.severity] ?? "advisory",
        title: `${f.ruleId}: ${f.message}`,
        description: undefined,
        file: file.file,
        line: f.line,
        resolved: false,
        ruleId: f.ruleId,
      });
    }
  }

  return {
    status: "ok",
    findings,
    base: res.base?.ref ?? null,
    blockCount: res.blockCount ?? 0,
    warnCount: res.warnCount ?? 0,
  };
}
