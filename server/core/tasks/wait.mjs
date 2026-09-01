// @ts-check
/**
 * How long work sat waiting on a person.
 *
 * Every duration here comes from two recorded transitions. Nothing is inferred
 * from idleness, from the last file write, or from when a session "looked
 * quiet": a task the engineer was actively thinking about is indistinguishable
 * from an abandoned one by those signals, and reporting thinking time as waste
 * is how a measurement starts lying.
 *
 * An open wait is reported as open, with the time so far, and never folded into
 * a total that reads as finished.
 */

/** States whose duration is time a human owed the task, not the other way. */
const HUMAN_WAIT = new Set(["CREATED", "NEEDS_HUMAN"]);
const WAIT_LABEL = {
  CREATED: "waiting to be launched",
  NEEDS_HUMAN: "waiting on a decision",
};

/**
 * @param {{transitions?: Array<{to:string, at:string}>, lifecycle?:string}} task
 * @param {{now?:number}} [opts]
 */
export function waitsFor(task, opts = {}) {
  const now = opts.now ?? Date.now();
  const t = (task?.transitions || [])
    .filter((x) => x?.to && x?.at)
    .map((x) => ({ to: x.to, at: Date.parse(x.at) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);

  const spans = [];
  for (let i = 0; i < t.length; i++) {
    if (!HUMAN_WAIT.has(t[i].to)) continue;
    const next = t[i + 1];
    spans.push({
      state: t[i].to,
      label: WAIT_LABEL[t[i].to],
      startedAt: new Date(t[i].at).toISOString(),
      endedAt: next ? new Date(next.at).toISOString() : null,
      ms: (next ? next.at : now) - t[i].at,
      open: !next,
    });
  }
  const closed = spans.filter((s) => !s.open);
  return {
    spans,
    closedMs: closed.reduce((sum, s) => sum + s.ms, 0),
    openMs: spans.filter((s) => s.open).reduce((sum, s) => sum + s.ms, 0),
    // Kept apart so a report can never present an unfinished wait as a total.
    hasOpenWait: spans.some((s) => s.open),
  };
}

/**
 * Fleet view across tasks. Median rather than mean: one task left open over a
 * weekend would otherwise set the number for everything else.
 */
export function waitSummary(tasks = [], opts = {}) {
  const per = tasks.map((task) => ({ id: task.id, ...waitsFor(task, opts) }));
  const closed = per.flatMap((p) => p.spans.filter((s) => !s.open));
  const sorted = closed.map((s) => s.ms).sort((a, b) => a - b);
  const median = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : Math.round(
          (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
        )
    : null;

  return {
    tasks: per.length,
    closedWaits: closed.length,
    openWaits: per.filter((p) => p.hasOpenWait).length,
    medianWaitMs: median,
    longest: closed.length
      ? closed.reduce((a, b) => (b.ms > a.ms ? b : a))
      : null,
    // No waits recorded is not "no waiting happened": it is no evidence.
    measured: closed.length > 0,
  };
}
