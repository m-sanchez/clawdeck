// @ts-check
/**
 * Assisted tasks: a unit of Claude work Clawdeck asked for on behalf of a
 * blocker, and what became of it.
 *
 * Lifecycle and outcome are separate on purpose. Lifecycle answers "is this
 * still going?"; outcome answers "what did it conclude?". Collapsing them makes
 * the correct result of a review task - deciding the reviewer was wrong and
 * changing nothing - indistinguishable from a task that achieved nothing, so a
 * task settles with NO_CHANGE_RECOMMENDED and that is a success.
 *
 * `SETTLED` also requires a captured result. An agent going quiet is not a
 * conclusion, and a task that merely stopped being observed is `STALLED`.
 */

export const LIFECYCLE = Object.freeze({
  CREATED: "CREATED",
  STARTING: "STARTING",
  RUNNING: "RUNNING",
  NEEDS_HUMAN: "NEEDS_HUMAN",
  STALLED: "STALLED",
  SETTLED: "SETTLED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

export const OUTCOME = Object.freeze({
  CHANGED: "CHANGED",
  NO_CHANGE_RECOMMENDED: "NO_CHANGE_RECOMMENDED",
  NEEDS_DECISION: "NEEDS_DECISION",
});

const TERMINAL = new Set([
  LIFECYCLE.SETTLED,
  LIFECYCLE.FAILED,
  LIFECYCLE.CANCELLED,
]);

/**
 * Legal moves. `CREATED → STARTING` is deliberately the only way in: the deep
 * link only prefills a prompt the human still has to submit, so a task sits in
 * CREATED with no watchdog until the correlation marker is actually observed.
 */
const ALLOWED = {
  CREATED: [LIFECYCLE.STARTING, LIFECYCLE.CANCELLED, LIFECYCLE.FAILED],
  STARTING: [
    LIFECYCLE.RUNNING,
    LIFECYCLE.STALLED,
    LIFECYCLE.NEEDS_HUMAN,
    LIFECYCLE.SETTLED,
    LIFECYCLE.FAILED,
    LIFECYCLE.CANCELLED,
  ],
  RUNNING: [
    LIFECYCLE.NEEDS_HUMAN,
    LIFECYCLE.STALLED,
    LIFECYCLE.SETTLED,
    LIFECYCLE.FAILED,
    LIFECYCLE.CANCELLED,
  ],
  // Both are pauses, not endings: work can resume from either.
  NEEDS_HUMAN: [
    LIFECYCLE.RUNNING,
    LIFECYCLE.SETTLED,
    LIFECYCLE.FAILED,
    LIFECYCLE.CANCELLED,
  ],
  STALLED: [
    LIFECYCLE.RUNNING,
    LIFECYCLE.SETTLED,
    LIFECYCLE.FAILED,
    LIFECYCLE.CANCELLED,
  ],
  SETTLED: [],
  FAILED: [],
  CANCELLED: [],
};

export const INTENTS = new Set([
  "explain",
  "investigate",
  "draft-reply",
  "draft-pushback",
  "fix",
  "review-fix",
]);

export function isTerminal(lifecycle) {
  return TERMINAL.has(lifecycle);
}

/** A fresh task record. Identity is ours and outlives any process or session. */
export function makeTask({ id, source, intent, worktree, marker, now }) {
  return {
    id,
    source: { kind: source?.kind ?? null, id: source?.id ?? null },
    intent,
    lifecycle: LIFECYCLE.CREATED,
    outcome: null,
    // Three identities, kept apart: ours, Claude's, and (never persisted) the
    // process. A task survives all of them going away.
    sessionId: null,
    correlationMarker: marker,
    worktree: worktree ?? null,
    createdAt: new Date(now).toISOString(),
    startedAt: null,
    endedAt: null,
    transitions: [
      {
        from: null,
        to: LIFECYCLE.CREATED,
        at: new Date(now).toISOString(),
        cause: "created",
      },
    ],
    baselineSha: null,
    evidence: { files: [], commit: null, tests: [] },
    reconciliation: "unknown",
    packetPath: null,
  };
}

/**
 * Apply a transition, or refuse it with a reason. Pure: callers persist the
 * returned task themselves.
 *
 * @param {object} task
 * @param {string} to
 * @param {{cause?: string, outcome?: string|null, now?: number, evidence?: object}} [opts]
 */
export function transition(task, to, opts = {}) {
  const now = opts.now ?? Date.now();
  const from = task.lifecycle;
  if (!LIFECYCLE[to]) return { ok: false, error: `Unknown lifecycle: ${to}` };
  if (!(ALLOWED[from] || []).includes(to))
    return { ok: false, error: `Illegal transition ${from} → ${to}` };

  // A conclusion has to be captured, not assumed: idleness is not a result.
  if (to === LIFECYCLE.SETTLED) {
    const outcome = opts.outcome ?? task.outcome;
    if (!outcome || !OUTCOME[outcome])
      return {
        ok: false,
        error: "SETTLED requires a captured outcome",
      };
  }

  const at = new Date(now).toISOString();
  const next = {
    ...task,
    lifecycle: to,
    outcome: opts.outcome !== undefined ? opts.outcome : task.outcome,
    transitions: [
      ...task.transitions,
      { from, to, at, cause: opts.cause ?? null },
    ].slice(-80),
  };
  if (to === LIFECYCLE.STARTING && !next.startedAt) next.startedAt = at;
  if (isTerminal(to)) next.endedAt = at;
  if (opts.evidence) next.evidence = { ...next.evidence, ...opts.evidence };
  return { ok: true, task: next };
}

/**
 * Bind a task to the Claude session that ran it. The marker must be the one
 * this task minted: a session that merely started nearby in time is a
 * candidate, never a binding.
 */
export function bindSession(task, { sessionId, marker, now, baselineSha }) {
  if (!sessionId) return { ok: false, error: "A session id is required." };
  if (!marker || marker !== task.correlationMarker)
    return {
      ok: false,
      error: "The correlation marker does not match this task.",
    };
  const started = transition(task, LIFECYCLE.STARTING, {
    cause: "correlation marker observed",
    now,
  });
  if (!started.ok) return started;
  return {
    ok: true,
    task: {
      ...started.task,
      sessionId,
      reconciliation: "bound",
      // The commit HEAD sat on when the work began. Evidence is later drawn
      // from `baseline..HEAD`, which is exact, rather than from a timestamp
      // window - git's own `--since` has one-second granularity and would
      // sweep in a commit made in the same second.
      baselineSha: baselineSha ?? null,
    },
  };
}

/**
 * Has a started task gone quiet for too long? The window only opens at
 * STARTING, so a human reading the prompt for two minutes is never "stalled".
 */
export function isStalled(task, { now, startupMs, idleMs }) {
  if (
    task.lifecycle !== LIFECYCLE.STARTING &&
    task.lifecycle !== LIFECYCLE.RUNNING
  )
    return false;
  const last = task.transitions[task.transitions.length - 1];
  const since = now - Date.parse(last?.at || task.createdAt);
  return task.lifecycle === LIFECYCLE.STARTING
    ? since > startupMs
    : since > idleMs;
}

/**
 * The outcome a settled fix task supports, from evidence alone. A task that
 * changed nothing is not a failure - it may be the correct answer - so the
 * caller decides between NO_CHANGE_RECOMMENDED and NEEDS_DECISION.
 */
export function outcomeFromEvidence(evidence) {
  const files = evidence?.files ?? [];
  return files.length ? OUTCOME.CHANGED : null;
}
