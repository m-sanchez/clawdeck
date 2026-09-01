// @ts-check
/**
 * CI for the change under review, kept out of the snapshot at full size.
 *
 * Two rules shape this file. CI is read for the commit the PR is on, never for
 * "the latest run" - a run that finished thirty seconds ago may belong to the
 * previous push, and reporting it as this commit's result is how a red build
 * gets announced as green. And the summary that reaches the browser carries no
 * log text at all: `/events` is tokenless, so job output stays behind the
 * token-gated route.
 */
import { getChecks } from "../forge/index.mjs";
import { freshness } from "../core/review-inbox/model.mjs";

const STALE_AFTER_MS = 300000;
const TOP_FAILURES = 8;

/**
 * Read CI for one commit.
 * @param {string} checkoutRoot
 * @param {{sha:string|null, pipelineId?:number|string|null}} ref
 * @param {{enabled?:boolean, fetchImpl?:Function, now?:number}} [opts]
 */
export async function getCi(checkoutRoot, ref, opts = {}) {
  const now = opts.now ?? Date.now();
  if (opts.enabled === false)
    return {
      available: false,
      reason: "disabled",
      observedAt: null,
      ref: null,
    };
  if (!ref?.sha)
    return {
      available: false,
      reason: "no-head-commit",
      observedAt: new Date(now).toISOString(),
      ref: null,
    };

  const result = await getChecks(checkoutRoot, ref, opts);
  return {
    available: Boolean(result?.ok),
    reason: result?.ok ? null : (result?.reason ?? "unavailable"),
    provider: result?.provider ?? null,
    ref: ref.sha,
    summary: result?.summary ?? null,
    contexts: result?.contexts ?? [],
    failures: result?.failures ?? [],
    observedAt: result?.observedAt ?? new Date(now).toISOString(),
  };
}

/**
 * Snapshot-sized projection: counts, coverage and failing job names. No logs,
 * no per-context timing, nothing that grows with the size of the pipeline.
 */
export function summarizeCi(ci, opts = {}) {
  const now = opts.now ?? Date.now();
  if (!ci) return { configured: false, available: false };
  if (!ci.available)
    return {
      configured: true,
      available: false,
      reason: ci.reason ?? "unavailable",
      provider: ci.provider ?? null,
      ref: ci.ref ?? null,
      observedAt: ci.observedAt ?? null,
      freshness: "unknown",
      summary: ci.summary ?? null,
      failures: [],
    };

  return {
    configured: true,
    available: true,
    provider: ci.provider ?? null,
    ref: ci.ref ?? null,
    observedAt: ci.observedAt,
    freshness: freshness(ci.observedAt, now, STALE_AFTER_MS),
    summary: ci.summary ?? null,
    // Names and links only: a failing job's log lives behind /api/ci.
    failures: (ci.failures || []).slice(0, TOP_FAILURES).map((f) => ({
      name: f.name,
      source: f.source ?? null,
      detailsUrl: f.detailsUrl ?? null,
      inspectable: Boolean(f.inspectable),
    })),
    failureCount: (ci.failures || []).length,
  };
}
