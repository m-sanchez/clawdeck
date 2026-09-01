// @ts-check
/**
 * The small projection of assisted tasks that rides in the snapshot.
 *
 * Counts and identities only. A task's brief lives in its own file and its
 * evidence can run to dozens of paths, none of which belongs in a payload the
 * tokenless SSE stream carries and the section hash re-serializes every tick.
 */
import { LIFECYCLE, isTerminal } from "./model.mjs";

const RECENT = 8;

/** @param {{tasks: object[]}} store */
export function summarizeTasks(store) {
  const tasks = store?.tasks ?? [];
  const counts = {
    total: tasks.length,
    open: 0,
    awaitingLaunch: 0,
    running: 0,
    needsHuman: 0,
    stalled: 0,
    settled: 0,
    failed: 0,
    cancelled: 0,
    unboundSessions: 0,
  };

  for (const t of tasks) {
    if (!isTerminal(t.lifecycle)) counts.open++;
    switch (t.lifecycle) {
      case LIFECYCLE.CREATED:
        counts.awaitingLaunch++;
        break;
      case LIFECYCLE.STARTING:
      case LIFECYCLE.RUNNING:
        counts.running++;
        break;
      case LIFECYCLE.NEEDS_HUMAN:
        counts.needsHuman++;
        break;
      case LIFECYCLE.STALLED:
        counts.stalled++;
        break;
      case LIFECYCLE.SETTLED:
        counts.settled++;
        break;
      case LIFECYCLE.FAILED:
        counts.failed++;
        break;
      case LIFECYCLE.CANCELLED:
        counts.cancelled++;
        break;
      default:
        break;
    }
    // A started task whose link we cannot prove is worth surfacing: it is the
    // one case where the panel knows it is missing something.
    if (!isTerminal(t.lifecycle) && t.startedAt && t.reconciliation !== "bound")
      counts.unboundSessions++;
  }

  const recent = [...tasks]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, RECENT)
    .map((t) => ({
      id: t.id,
      source: t.source,
      intent: t.intent,
      lifecycle: t.lifecycle,
      outcome: t.outcome,
      // Enough to point at the work, never the work itself.
      sessionId: t.sessionId ?? null,
      commit: t.evidence?.commit?.sha ?? null,
      fileCount: t.evidence?.files?.length ?? 0,
      reconciliation: t.reconciliation,
      createdAt: t.createdAt,
    }));

  return { counts, recent };
}

/** Which tasks a given blocker (a review thread, say) produced. */
export function tasksForSource(store, kind, id) {
  return (store?.tasks ?? []).filter(
    (t) => t.source?.kind === kind && t.source?.id === id,
  );
}
