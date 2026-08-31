// @ts-check
/**
 * Assemble a PanelSnapshot from the adapters and stamp the derived Clawd
 * presentation + the needs-attention queue. Cheap adapters (checkout, worktrees,
 * runs) run every call; the expensive ones (reviews scan, validation report) are
 * passed in from the server's cache so the SSE tick never reshells git.
 */
import { getCheckout } from "../adapters/checkout.mjs";
import { getWorktrees } from "../adapters/worktrees.mjs";
import { getRuns } from "../adapters/runs.mjs";
import { getLogSources } from "../adapters/logs.mjs";
import { getReadiness } from "../adapters/readiness.mjs";
import { getSessions } from "../adapters/sessions.mjs";
import { getLiveTelemetry } from "../adapters/telemetry-live.mjs";
import { getPolicy } from "../adapters/policy.mjs";
import { rollupCost } from "../core/telemetry/rollup.mjs";
import { detectWaste } from "../core/telemetry/detectors.mjs";
import { readAgentModelPins } from "../core/telemetry/agent-models.mjs";
import {
  evaluateGovernor,
  readFablePolicy,
} from "../core/telemetry/governor.mjs";
import { computeQuotaPressure } from "../core/telemetry/quota-pressure.mjs";
import { deriveDelivery } from "../core/delivery/lifecycle.mjs";
import { findingId } from "../core/findings/model.mjs";
import {
  readFindingStore,
  writeFindingStore,
  reconcileFindings,
  decorateFindings,
  activeStoreFindings,
} from "../core/findings/store.mjs";
import { getMergedRemoteBranches } from "../adapters/remote-branches.mjs";
import { getRecentCommits } from "../adapters/recent-commits.mjs";
import { getCommitActivity } from "../adapters/commit-activity.mjs";
import { getAuthorBreakdown } from "../adapters/author-breakdown.mjs";
import { getReviewHistory } from "../adapters/reviews.mjs";
import { readSetupState } from "./setup-state.mjs";
import { recordSample } from "./history.mjs";
import { getInstructionBudget } from "../adapters/instruction-budget.mjs";
import { deriveClawdPresentation } from "../../ui/shared/clawd-state.mjs";

/** Time one adapter and record its duration into perf (when supplied). */
async function timed(perf, name, thunk) {
  const t0 = perf ? Date.now() : 0;
  try {
    return await thunk();
  } finally {
    if (perf) perf.recordAdapter(name, Date.now() - t0);
  }
}

/**
 * Overlay event-derived session state onto the mtime/telemetry agents. When an
 * agent has an event projection its truthful running/idle/completed state wins
 * for "is it actively working"; without one, the mtime/sample signal stands.
 */
function overlayEventState(sessions, events) {
  const byId = new Map((events?.sessions ?? []).map((s) => [s.sessionId, s]));
  const WORKING = new Set(["starting", "running", "compacting"]);
  for (const a of sessions.agents) {
    const proj = byId.get(a.latestSessionId);
    if (!proj) continue;
    a.eventState = proj.state;
    a.active = WORKING.has(proj.state);
  }
  sessions.activeCount = sessions.agents.filter((a) => a.active).length;
}

/** Build the needs-attention queue, highest urgency first. */
function buildAttention(runs, reviews, validation) {
  const items = [];
  for (const run of runs) {
    if (run.status === "failed" || run.blockedReason) {
      items.push({
        id: `run-blocked-${run.id}`,
        kind: "run",
        severity: "blocking",
        title: `Run failed: ${run.title}`,
        detail: run.blockedReason ?? null,
        link: `#/runs/${run.id}`,
      });
    } else if (run.requiresInput) {
      items.push({
        id: `run-input-${run.id}`,
        kind: "run",
        severity: "attention",
        title: `Input needed: ${run.title}`,
        detail: null,
        link: `#/runs/${run.id}`,
      });
    } else if (run.stale) {
      items.push({
        id: `run-stale-${run.id}`,
        kind: "run",
        severity: "warning",
        title: `Run stalled: ${run.title}`,
        detail: "No progress within the wall-clock window.",
        link: `#/runs/${run.id}`,
      });
    }
  }
  if (reviews?.blockCount > 0) {
    items.push({
      id: "review-blocking",
      kind: "review",
      severity: "blocking",
      title: `${reviews.blockCount} blocking review finding(s)`,
      detail: "These would block a push.",
      link: "#/reviews",
    });
  }
  if (Array.isArray(validation?.checks)) {
    const failed = validation.checks.filter((c) => c.status === "failed");
    if (failed.length) {
      items.push({
        id: "validation-failed",
        kind: "validation",
        severity: "blocking",
        title: `${failed.length} validation check(s) failing`,
        detail: failed.map((c) => `${c.project}:${c.label}`).join(", "),
        link: "#/validation",
      });
    }
  }
  const order = { blocking: 0, attention: 1, warning: 2 };
  return items.sort(
    (a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9),
  );
}

/**
 * @param {{ checkoutId: string, checkoutRoot: string, repoRoot: string, branch?: string, runtimeDir: string }} ctx
 * @param {{ reviews: any, validation: any, jobs?: any[], panel?: any, forge?: any, events?: any, perf?: any }} cached
 */
export async function buildSnapshot(ctx, cached) {
  const perf = cached.perf ?? null;
  const t0 = Date.now();
  const [
    checkout,
    worktrees,
    runs,
    remoteBranches,
    recentCommits,
    commitActivity,
    authorBreakdown,
  ] = await Promise.all([
    timed(perf, "checkout", () => getCheckout(ctx)),
    timed(perf, "worktrees", () => getWorktrees(ctx)),
    timed(perf, "runs", () => getRuns(ctx)),
    timed(perf, "remoteBranches", () => getMergedRemoteBranches(ctx)),
    timed(perf, "recentCommits", () => getRecentCommits(ctx)),
    timed(perf, "commitActivity", () => getCommitActivity(ctx)),
    timed(perf, "authorBreakdown", () => getAuthorBreakdown(ctx)),
  ]);
  const reviews = cached.reviews ?? {
    status: "pending",
    findings: [],
    blockCount: 0,
    warnCount: 0,
    base: null,
  };
  const validation = cached.validation ?? {
    status: "none",
    checks: [],
    passed: false,
    ranAt: null,
  };
  const attention = buildAttention(runs, reviews, validation);
  const telemetry = getLiveTelemetry(ctx, worktrees);
  const sessions = getSessions(
    ctx,
    worktrees,
    process.env.CLAUDE_CODE_SESSION_ID,
    telemetry,
  );
  const events = cached.events ?? { sessions: [], count: 0 };
  overlayEventState(sessions, events);
  const policy = getPolicy(ctx, worktrees);
  for (const a of sessions.agents) {
    const pol = policy.sessions[a.latestSessionId];
    if (pol) {
      a.workflow = pol.workflow;
      a.readOnly = pol.readOnly;
      a.approvalRequired = pol.approvalRequired && !pol.approved;
      a.policyState = pol.state ?? null;
      a.policyRevision = pol.revision ?? null;
      a.rejected = pol.rejected === true;
    }
  }
  const cost = {
    rollup: rollupCost(telemetry, events),
    findings: detectWaste(telemetry, events, {
      agentModelPins: readAgentModelPins(ctx.checkoutRoot),
    }),
  };
  const governor = evaluateGovernor(
    cost.rollup,
    readFablePolicy(ctx.checkoutRoot),
  );
  // Plan pressure is a different axis from API-equivalent cost: it comes from
  // the harness's own rate-limit windows and drives nothing automatically.
  const quotaPressure = computeQuotaPressure(telemetry.sessions);
  // Durable Fix Station: reconcile the fresh scan against the persisted
  // lifecycle store (survives restart), persist only when it changed, and
  // decorate each finding with its lifecycle state for the view.
  const scanned = (reviews.findings ?? []).map((f) => ({
    ...f,
    findingId: findingId(f),
  }));
  let findings = scanned;
  try {
    const store = readFindingStore(ctx.runtimeDir);
    // Only reconcile against a scan we can TRUST. When the review did not
    // actually run (status !== "ok": unavailable / error / base-undeterminable),
    // findings===[] is not evidence anything was fixed, so reconciling would
    // falsely advance confirmed findings to "changed". Decorate from the
    // existing store instead and leave lifecycle state untouched.
    let live = store;
    if (reviews.status === "ok") {
      const { store: next, changed } = reconcileFindings(store, scanned);
      if (changed) writeFindingStore(ctx.runtimeDir, next);
      live = next;
    }
    // Union the scanned findings with store-only records still awaiting
    // verification (fixed → absent from the scan) so the resolve path stays
    // reachable in the Fix Station instead of vanishing at "changed".
    findings = [
      ...decorateFindings(scanned, live),
      ...activeStoreFindings(live, scanned),
    ];
  } catch {
    /* store unavailable: fall back to undecorated findings */
  }

  const snapshot = {
    checkout,
    runs,
    worktrees,
    validation,
    reviews,
    findings,
    attention,
    jobs: cached.jobs ?? [],
    sessions,
    telemetry,
    events,
    policy,
    cost,
    governor,
    quotaPressure,
    remoteBranches,
    recentCommits,
    commitActivity,
    authorBreakdown,
    reviewHistory: getReviewHistory(ctx.runtimeDir),
    readiness: getReadiness(ctx, checkout.commit, validation, reviews),
    logSources: getLogSources(ctx),
    setup: readSetupState(ctx.runtimeDir),
    instructionBudget: getInstructionBudget(ctx, events),
    emittedAt: new Date().toISOString(),
  };
  snapshot.history = recordSample({
    t: snapshot.emittedAt,
    activeAgents: sessions.activeCount,
    runningJobs: (cached.jobs ?? []).filter((j) => j.status === "running")
      .length,
    activeRuns: runs.filter(
      (r) => r.status === "running" || r.status === "waiting",
    ).length,
  });
  snapshot.panel = cached.panel
    ? { ...cached.panel, historyPoints: snapshot.history.length }
    : null;
  snapshot.forge = cached.forge ?? { configured: false };
  snapshot.delivery = deriveDelivery(snapshot);
  // Record this build's wall-clock and expose the panel's self-perf summary.
  if (perf) {
    perf.recordSnapshot(Date.now() - t0);
    snapshot.perf = perf.summary({
      sseClients: cached.panel?.sseClients ?? null,
      eventBacklog: cached.events?.backlog ?? null,
      eventStoreBytes: cached.events?.storeBytes ?? null,
    });
  }
  snapshot.clawd = deriveClawdPresentation(snapshot);
  return snapshot;
}
