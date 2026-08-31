// @ts-check
/**
 * The one pure derivation layer from workflow facts to a Clawd presentation.
 * Imported by BOTH the server (authoritative, it stamps `snapshot.clawd`) and
 * the browser. No DOM, no Node, no I/O: same input always yields the same
 * output, which is what makes it unit-testable and trustworthy.
 *
 * The runtime mirror of `contracts/clawd-state.ts`. The reference playground
 * names two states `working`/`validating`; the contract (and this module) name
 * them `coding`/`inspecting`. The component maps contract → reference.
 */

/** @typedef {'sleeping'|'thinking'|'idle'|'reading'|'coding'|'inspecting'|'reviewing'|'waiting'|'attention'|'blocked'|'success'} ClawdState */
/** @typedef {'full'|'reduced'|'none'} ClawdMotion */

export const CLAWD_STATES = /** @type {ClawdState[]} */ ([
  "sleeping",
  "thinking",
  "idle",
  "reading",
  "coding",
  "inspecting",
  "reviewing",
  "waiting",
  "attention",
  "blocked",
  "success",
]);

/** Map a run phase to its working Clawd state. */
const PHASE_TO_STATE = /** @type {Record<string, ClawdState>} */ ({
  investigating: "reading",
  planning: "thinking",
  implementing: "coding",
  validating: "inspecting",
  reviewing: "reviewing",
  waiting: "waiting",
});

/**
 * Contract-compatible mapping from minimal facts to a single state, in the
 * documented precedence order (blocked > attention > success > phases > idle).
 * @param {{ blocked?: boolean, requiresInput?: boolean, completed?: boolean, phase?: string, hasActiveRun?: boolean }} facts
 * @returns {ClawdState}
 */
export function deriveClawdState(facts) {
  if (facts.blocked) return "blocked";
  if (facts.requiresInput) return "attention";
  if (facts.completed) return "success";
  if (facts.phase && PHASE_TO_STATE[facts.phase])
    return PHASE_TO_STATE[facts.phase];
  return facts.hasActiveRun ? "idle" : "sleeping";
}

/** States whose message stays pinned and that always warrant a badge. */
const PERSISTENT = new Set(["attention", "blocked"]);

/**
 * Derive the full Clawd presentation from a panel snapshot. Pure.
 * @param {any} snapshot
 * @returns {{ state: ClawdState, message: string, showBadge: boolean, patrol: boolean, persistent: boolean, source: string|null }}
 */
export function deriveClawdPresentation(snapshot) {
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  const reviews = snapshot?.reviews ?? {};
  const validation = snapshot?.validation ?? {};
  const worktrees = Array.isArray(snapshot?.worktrees)
    ? snapshot.worktrees
    : [];

  const active = runs.filter((r) => r.status === "running");
  const failed = runs.find((r) => r.status === "failed" || r.blockedReason);
  const needsInput = runs.find((r) => r.requiresInput);
  const validationFailed =
    Array.isArray(validation.checks) &&
    validation.checks.some((c) => c.status === "failed");
  const blockingFindings = Number(reviews.blockCount) || 0;

  // 1. blocked
  if (failed) {
    return present(
      "blocked",
      failed.blockedReason || `Run "${short(failed.title)}" cannot continue.`,
      failed.id,
    );
  }
  // 2. attention required
  if (needsInput) {
    return present(
      "attention",
      `"${short(needsInput.title)}" needs your input.`,
      needsInput.id,
    );
  }
  if (blockingFindings > 0) {
    return present(
      "attention",
      `${blockingFindings} blocking review finding${blockingFindings === 1 ? "" : "s"} to resolve.`,
      null,
    );
  }
  if (validationFailed) {
    return present(
      "attention",
      "Validation is failing, see the Validation view.",
      null,
    );
  }

  // 3. active phase
  if (active.length) {
    const run = active.find((r) => !r.stale) ?? active[0];
    if (run.stale)
      return present(
        "waiting",
        `"${short(run.title)}" is taking a while…`,
        run.id,
      );
    const state = PHASE_TO_STATE[run.phase] ?? "coding";
    return present(state, phaseMessage(state, run), run.id);
  }

  // 4. success, most recent run completed, nothing active
  const recent = runs[0];
  if (recent && recent.status === "passed") {
    return present("success", `"${short(recent.title)}" completed.`, recent.id);
  }

  // 4b. a running panel job, reflect the kind of work it is
  const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
  const runningJob = jobs.find((j) => j.status === "running");
  if (runningJob) {
    return present(
      jobState(runningJob),
      `Running ${short(runningJob.label)}…`,
      runningJob.id ?? null,
    );
  }

  // 4c. live Claude sessions working in this repo's checkouts
  const activeAgents = Number(snapshot?.sessions?.activeCount) || 0;
  if (activeAgents > 0) {
    return present(
      "thinking",
      `${activeAgents} Claude agent${activeAgents === 1 ? "" : "s"} working.`,
      null,
    );
  }

  // 5. quiet supervision vs sleeping
  const servicesUp = worktrees.some((w) =>
    (w.services ?? []).some((s) => s.status === "running"),
  );
  if (servicesUp)
    return present("idle", "Keeping watch over running services.", null);
  return present("sleeping", "Nothing active right now.", null);
}

/** Map a running panel job to the Clawd state that best describes the work. */
function jobState(job) {
  const key = String(job?.key ?? "");
  if (/review|pack/.test(key)) return "reviewing";
  if (/verify|test|validat/.test(key)) return "inspecting";
  if (/lint|fix/.test(key)) return "coding";
  if (/git|disk|cleanup|doctor/.test(key)) return "reading";
  return "coding";
}

function present(state, message, source) {
  return {
    state,
    message,
    showBadge: PERSISTENT.has(state) || state === "success",
    patrol: state === "idle",
    persistent: PERSISTENT.has(state),
    source,
  };
}

function phaseMessage(state, run) {
  const title = short(run.title);
  switch (state) {
    case "reading":
      return `Reading context for "${title}".`;
    case "thinking":
      return `Planning "${title}".`;
    case "coding":
      return `Working on "${title}" (iteration ${run.iteration ?? "?"}/${run.maxIterations ?? "?"}).`;
    case "inspecting":
      return `Validating "${title}".`;
    case "reviewing":
      return `Reviewing "${title}".`;
    case "waiting":
      return `Waiting on an external step for "${title}".`;
    default:
      return `Working on "${title}".`;
  }
}

function short(text, max = 40) {
  const s = String(text ?? "").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
