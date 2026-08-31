// @ts-check
/**
 * Runs adapter. Autoloop runs (`.claude/.state/loops/<id>/state.json`, owned by
 * `loop-state.mjs`) are the real, inspectable run records in this repository, so
 * the panel surfaces them rather than inventing a parallel run store.
 *
 * @typedef {import('../../../contracts/panel-protocol').RunSummary} RunSummary
 * @typedef {import('../../../contracts/panel-protocol').RunPhase} RunPhase
 * @typedef {import('../../../contracts/panel-protocol').RunStatus} RunStatus
 */
import { join } from "node:path";
import { loadEsm } from "../lib/repo-modules.mjs";

/** @type {Record<string, RunStatus>} */
const STATUS_MAP = {
  running: "running",
  completed: "passed",
  stopped: "stopped",
  failed: "failed",
};
/** @type {Record<string, RunPhase>} */
const PHASE_MAP = {
  running: "implementing",
  completed: "completed",
  stopped: "cancelled",
  failed: "failed",
};

/** @returns {RunSummary & Record<string, unknown>} */
function toSummary(run, stale) {
  const updatedAt =
    Array.isArray(run.history) && run.history.length
      ? run.history[run.history.length - 1].at
      : run.startTime;
  const status =
    stale && run.status === "running"
      ? "waiting"
      : (STATUS_MAP[run.status] ?? "stopped");
  return {
    id: run.runId,
    title: run.task || "(untitled loop run)",
    phase: PHASE_MAP[run.status] ?? "queued",
    status,
    progress: run.maxIterations
      ? Math.min(1, (run.currentIteration ?? 0) / run.maxIterations)
      : undefined,
    startedAt: run.startTime,
    updatedAt,
    requiresInput: false,
    blockedReason: run.failureReason ?? undefined,
    // Extra fields consumed by the UI:
    kind: "autoloop",
    iteration: run.currentIteration ?? 0,
    maxIterations: run.maxIterations ?? null,
    consecutiveNoProgress: run.consecutiveNoProgress ?? 0,
    stale: Boolean(stale && run.status === "running"),
    owner: run.owner ?? null,
    scope: run.scope ?? null,
    stoppingCondition: run.stoppingCondition ?? null,
  };
}

async function loadModule(checkoutRoot) {
  const mod = await loadEsm(checkoutRoot, ".claude/scripts/loop-state.mjs");
  return mod && typeof mod.listRuns === "function" ? mod : null;
}

/**
 * @param {{ checkoutRoot: string }} ctx
 * @returns {Promise<RunSummary[]>}
 */
export async function getRuns(ctx) {
  const mod = await loadModule(ctx.checkoutRoot);
  if (!mod) return [];
  const stateRoot = join(ctx.checkoutRoot, ".claude");
  let active = [];
  let stale = [];
  try {
    ({ active, stale } = mod.listRuns(stateRoot));
  } catch {
    return [];
  }
  return [
    ...active.map((r) => toSummary(r, false)),
    ...stale.map((r) => toSummary(r, mod.isStale ? mod.isStale(r) : false)),
  ].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/**
 * Full detail for one run, including the iteration timeline.
 * @param {{ checkoutRoot: string }} ctx
 * @param {string} runId
 */
export async function getRunDetails(ctx, runId) {
  // Run ids are timestamp-hex slugs; reject anything that could traverse the path.
  if (!runId || /[^\w.-]/.test(runId) || runId.includes("..")) return null;
  const mod = await loadModule(ctx.checkoutRoot);
  if (!mod || typeof mod.readRun !== "function") return null;
  const stateRoot = join(ctx.checkoutRoot, ".claude");
  const run = mod.readRun(stateRoot, runId);
  if (!run) return null;
  const stale = mod.isStale ? mod.isStale(run) : false;
  return {
    ...toSummary(run, stale),
    timeline: (run.history ?? []).map((h) => ({
      iteration: h.iteration,
      at: h.at,
      progressed: h.progressed,
      evidence: h.evidence ?? null,
    })),
    lastEvidence: run.lastProgressEvidence ?? null,
    failureReason: run.failureReason ?? null,
  };
}
