// @ts-check
/**
 * Fable Governor: observe/warn over the live cost rollup, plus the PURE
 * loop-boundary gate decision. Enforce-tier gating is opt-in (mode: "enforce");
 * the default is "warn" — the plan deliberately does not jump to hard blocking
 * for Fable. Accurate month-to-date projection needs persisted rollups or the
 * OTEL receiver, so it is reported only when a monthToDate is supplied.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every field here is consumed end-to-end (no decorative settings):
//   mode             -> gates (enforce) vs observe/warn everywhere below
//   perLoopSoftUsd   -> evaluateLoopBoundary / shouldGateNextIteration (loop gate)
//   warnThresholdPct -> the loop warn threshold
//   maxFableSharePct -> share advisory; null (default) disables it
//
// There is no monthly target. The subscription price is not an API budget, and
// the projection it fed was unreachable in production anyway. Real plan pressure
// is `quotaPressure`, derived from the rate-limit windows the harness reports.
export const DEFAULT_FABLE_POLICY = {
  warnThresholdPct: 0.8,
  perLoopSoftUsd: 10,
  maxFableSharePct: null,
  mode: "warn", // observe | warn | enforce
};

const round = (n) => Math.round(n * 100) / 100;

/** Runtime override merged over the defaults; missing/unreadable -> defaults. */
export function readFablePolicy(checkoutRoot) {
  try {
    const file = join(
      checkoutRoot,
      ".claude",
      ".runtime",
      "telemetry",
      "fable-policy.json",
    );
    return {
      ...DEFAULT_FABLE_POLICY,
      ...JSON.parse(readFileSync(file, "utf8")),
    };
  } catch {
    return { ...DEFAULT_FABLE_POLICY };
  }
}

/**
 * @param {any} rollup snapshot.cost.rollup
 * @param {any} [policy]
 */
export function evaluateGovernor(rollup, policy = DEFAULT_FABLE_POLICY) {
  const p = { ...DEFAULT_FABLE_POLICY, ...(policy || {}) };
  const fableCostUsd = rollup?.fable?.costUsd || 0;
  const share = rollup?.fable?.share || 0;
  const warnings = [];
  // Advisory only, and off unless a runtime policy opts in: a share of live
  // API-equivalent spend is not a spending limit.
  if (typeof p.maxFableSharePct === "number" && share > p.maxFableSharePct)
    warnings.push({
      type: "fable-share-high",
      advisory: true,
      detail: `Advisory: Fable is ${Math.round(share * 100)}% of live API-equivalent spend (advisory threshold ${Math.round(p.maxFableSharePct * 100)}%)`,
    });

  return {
    mode: p.mode,
    fableCostUsd,
    share,
    perLoopSoftUsd: p.perLoopSoftUsd,
    warnings,
  };
}

/**
 * Pure loop-boundary decision: stop before the next iteration when this loop's
 * Fable spend crossed the soft budget. Only gates in enforce mode; observe/warn
 * never gate. This is the ONLY safe Fable enforcement point (a boundary, never
 * mid-generation) — the loop's Stop hook can call it before continuing.
 * @param {number} fableSpentThisLoopUsd
 * @param {any} [policy]
 */
export function shouldGateNextIteration(
  fableSpentThisLoopUsd,
  policy = DEFAULT_FABLE_POLICY,
) {
  const p = { ...DEFAULT_FABLE_POLICY, ...(policy || {}) };
  if (p.mode !== "enforce") return false;
  const spent = Number(fableSpentThisLoopUsd) || 0;
  return spent > 0 && p.perLoopSoftUsd > 0 && spent >= p.perLoopSoftUsd;
}

/**
 * Pure loop-boundary evaluation for the autonomous-loop Stop hook. Attributes
 * this loop's Fable spend from the session cost delta since costStartUsd. The
 * CALLER must pass the anchor for the current contiguous Fable span, which
 * loop-state.effectiveFableAnchor computes (and the Stop hook consults before
 * this call, so a transition back into Fable does not fold in the intervening
 * non-Fable spend). Attribution is session-granular and approximate: a non-Fable
 * CURRENT sample yields zero, and only the current Fable span accumulates
 * (mixed-model runs are conservative, never over-attributing to Fable). Then
 * decides whether to GATE the next iteration.
 * Never kills an in-flight response: the caller invokes this only after an
 * iteration has completed. An explicit `override` resumes despite the budget.
 * @param {{ costStartUsd?:number, costNowUsd?:number, model?:string,
 *   policy?:any, override?:boolean }} a
 * @returns {{ model:string|null, isFable:boolean, deltaUsd:number,
 *   fableDeltaUsd:number, budgetUsd:number, mode:string, warn:boolean,
 *   gate:boolean, overridden:boolean, reason:string }}
 */
export function evaluateLoopBoundary(a = {}) {
  const p = { ...DEFAULT_FABLE_POLICY, ...(a.policy || {}) };
  const model = a.model || null;
  const isFable = /fable/i.test(model || "");
  const start = Number(a.costStartUsd) || 0;
  const nowCost = Number(a.costNowUsd) || 0;
  const deltaUsd = round(Math.max(0, nowCost - start));
  const fableDeltaUsd = isFable ? deltaUsd : 0;
  const budgetUsd = p.perLoopSoftUsd;
  const warn =
    budgetUsd > 0 &&
    fableDeltaUsd >= budgetUsd * (p.warnThresholdPct ?? 0.8) &&
    fableDeltaUsd < budgetUsd;
  // Require positive spend AND a positive budget: a $0 budget or a $0 (or
  // non-Fable) loop must never gate.
  const over = fableDeltaUsd > 0 && budgetUsd > 0 && fableDeltaUsd >= budgetUsd;
  const overridden = Boolean(a.override);
  const gate = p.mode === "enforce" && over && !overridden;
  let reason;
  if (gate)
    reason = `soft loop budget $${budgetUsd} exceeded ($${fableDeltaUsd})`;
  else if (overridden && over) reason = "over budget but overridden — resuming";
  else if (over)
    reason = `over budget ($${fableDeltaUsd}) but mode is ${p.mode}`;
  else if (warn)
    reason = `approaching budget ($${fableDeltaUsd}/$${budgetUsd})`;
  else reason = `within budget ($${fableDeltaUsd}/$${budgetUsd})`;
  return {
    model,
    isFable,
    deltaUsd,
    fableDeltaUsd,
    budgetUsd,
    mode: p.mode,
    warn,
    gate,
    overridden,
    reason,
  };
}
