// @ts-check
/**
 * Turn provider facts, git facts and local marks into the one state a thread
 * shows - and the evidence for it.
 *
 * Two rules hold this together. Facts from different sources describe different
 * dimensions and coexist: "the provider says unresolved" and "git says the code
 * changed" are both true at once, and neither overrides the other. Precedence
 * exists only inside this single derivation, to pick what to display.
 *
 * And `REMOTE_RESOLVED` is reachable from exactly one input: the provider
 * saying so. `LIKELY_ADDRESSED` is a different state with `certainty: "likely"`
 * and no code path leads from it to resolution.
 */

export const STATES = Object.freeze({
  REMOTE_RESOLVED: "REMOTE_RESOLVED",
  STALE: "STALE",
  NEEDS_HUMAN: "NEEDS_HUMAN",
  FIX_IN_PROGRESS: "FIX_IN_PROGRESS",
  REPLY_DRAFTED: "REPLY_DRAFTED",
  INVESTIGATING: "INVESTIGATING",
  LIKELY_ADDRESSED: "LIKELY_ADDRESSED",
  LOCALLY_CHANGED: "LOCALLY_CHANGED",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  UNREAD: "UNREAD",
  OPEN: "OPEN",
});

const ev = (kind, note, ref) => (ref ? { kind, note, ref } : { kind, note });

/**
 * @param {object} thread   normalized ReviewThread
 * @param {object|null} local  stored marks for this thread
 * @param {object|null} facts  git facts for this thread
 * @param {{now?: number, changeState?: string, tasks?: object[]}} [opts]
 * @returns {{state: string, authority: string, certainty: string,
 *            reasons: string[], evidence: object[], unknowns: string[]}}
 */
export function deriveThreadDisplayState(thread, local, facts, opts = {}) {
  const now = opts.now ?? Date.now();
  const remote = thread?.remote || {};
  const unknowns = [...(facts?.unknowns || [])];
  const evidence = [];
  const reasons = [];

  if (remote.resolved === null) unknowns.push("remote-resolution");

  // Provider facts first: only the forge can say a thread is resolved.
  if (remote.resolved === true) {
    return out(
      STATES.REMOTE_RESOLVED,
      "forge",
      "known",
      [
        remote.resolvedBy
          ? `the provider reports this resolved by ${remote.resolvedBy}`
          : "the provider reports this thread resolved",
      ],
      [ev("forge", "remote.resolved = true", thread.remoteUrl)],
      unknowns,
    );
  }

  const changeClosed =
    opts.changeState &&
    opts.changeState !== "opened" &&
    opts.changeState !== "open";
  if (changeClosed || remote.outdated === true) {
    reasons.push(
      changeClosed
        ? `the change is ${opts.changeState}`
        : "the provider marked this thread outdated",
    );
    evidence.push(ev("forge", reasons[reasons.length - 1], thread.remoteUrl));
    return out(STATES.STALE, "forge", "known", reasons, evidence, unknowns);
  }

  // Human marks next: an explicit decision outranks anything inferred.
  if (local?.mark === "needs-human") {
    return out(
      STATES.NEEDS_HUMAN,
      "human",
      "known",
      ["marked as needing a human decision"],
      [ev("human", `marked at ${local.markAt || "unknown time"}`)],
      unknowns,
    );
  }
  if (local?.draft?.chars > 0) {
    return out(
      STATES.REPLY_DRAFTED,
      "human",
      "known",
      ["a reply draft is saved locally"],
      [
        ev("human", `${local.draft.chars} character draft`),
        ev("forge", "the reply has not been posted", thread.remoteUrl),
      ],
      unknowns,
    );
  }
  if (local?.mark === "investigating") {
    return out(
      STATES.INVESTIGATING,
      "human",
      "known",
      ["marked as under investigation"],
      [ev("human", `marked at ${local.markAt || "unknown time"}`)],
      unknowns,
    );
  }

  // Assisted work on this thread. A task only speaks once it has actually
  // concluded: one still running says the fix is under way, never that it
  // worked, and a task that failed says nothing at all.
  const tasks = opts.tasks ?? [];
  const settled = tasks.filter((t) => t.lifecycle === "SETTLED");
  const inFlight = tasks.filter((t) =>
    ["CREATED", "STARTING", "RUNNING", "NEEDS_HUMAN", "STALLED"].includes(
      t.lifecycle,
    ),
  );

  const pushback = settled.find(
    (t) => t.outcome === "NO_CHANGE_RECOMMENDED" || t.outcome === "NEEDS_DECISION",
  );
  if (pushback) {
    return out(
      STATES.NEEDS_HUMAN,
      "clawdeck",
      "known",
      [
        pushback.outcome === "NO_CHANGE_RECOMMENDED"
          ? "an assisted task concluded the review does not hold"
          : "an assisted task needs a decision before it can continue",
        "the provider still reports this thread unresolved",
      ],
      [
        ev("task", `task ${pushback.id} settled as ${pushback.outcome}`),
        ev("forge", "nothing was replied or resolved remotely", thread.remoteUrl),
      ],
      unknowns,
    );
  }

  if (inFlight.length) {
    const t = inFlight[0];
    const running = t.lifecycle === "RUNNING" || t.lifecycle === "STARTING";
    return out(
      STATES.FIX_IN_PROGRESS,
      "clawdeck",
      "known",
      [
        running
          ? "an assisted task is working on this thread"
          : t.lifecycle === "CREATED"
            ? "an assisted task is waiting to be launched"
            : `an assisted task is ${t.lifecycle.toLowerCase().replace("_", " ")}`,
      ],
      [
        ev("task", `task ${t.id} is ${t.lifecycle}`),
        t.sessionId
          ? ev("task", `bound to session ${t.sessionId.slice(0, 8)}`)
          : ev("task", "no session bound yet"),
      ],
      unknowns,
    );
  }

  // Git facts: what the local code says. Never a claim about the remote.
  const changedSince = facts?.fileChanged === true;
  const lineChanged =
    facts?.mapping?.kind === "changed" || facts?.mapping?.kind === "deleted";
  if (changedSince) {
    evidence.push(ev("git", "the reviewed file changed since the review"));
    if (facts.mapping?.reasons?.length)
      evidence.push(ev("git", facts.mapping.reasons[0]));
    if (facts.blameSha)
      evidence.push(ev("git", "last touched in", facts.blameSha));
  }

  // A settled task that changed code is the strongest evidence available, but
  // it is still an inference about whether the REVIEW was addressed, so the
  // certainty stays "likely" and the remote fact stays visible beside it.
  const settledChanged = settled.find((t) => t.outcome === "CHANGED");
  if (settledChanged) {
    evidence.push(
      ev("task", `task ${settledChanged.id} settled having changed code`),
    );
    if (settledChanged.evidence?.commit?.sha)
      evidence.push(
        ev("git", "committed in", settledChanged.evidence.commit.sha),
      );
    for (const t of settledChanged.evidence?.tests ?? [])
      if (t.status === "passed") evidence.push(ev("test", `${t.label ?? t.id} passed`));
  }

  if (settledChanged || (changedSince && lineChanged)) {
    return out(
      STATES.LIKELY_ADDRESSED,
      "clawdeck",
      "likely",
      [
        settledChanged
          ? "an assisted task settled after changing code here"
          : "the reviewed range changed after the review",
        "the provider still reports this thread unresolved",
      ],
      evidence,
      unknowns,
    );
  }
  if (changedSince || facts?.dirty) {
    if (facts?.dirty)
      evidence.push(ev("git", "the reviewed file has uncommitted changes"));
    return out(
      STATES.LOCALLY_CHANGED,
      "git",
      "known",
      ["the reviewed file changed, but not the reviewed lines"],
      evidence,
      unknowns,
    );
  }

  // Nothing observed: fall back to how far the human has got with it.
  const updated = Date.parse(thread?.updatedAt || "");
  const read = local?.lastReadAt ?? null;
  if (read != null && (!Number.isFinite(updated) || read >= updated)) {
    return out(
      STATES.ACKNOWLEDGED,
      "human",
      "known",
      ["read locally, with no newer activity"],
      [ev("human", `read at ${new Date(read).toISOString()}`)],
      unknowns,
    );
  }
  if (read == null || (Number.isFinite(updated) && updated > read)) {
    return out(
      STATES.UNREAD,
      "human",
      "known",
      [read == null ? "not read yet" : "updated since it was read"],
      [ev("forge", `updated ${thread?.updatedAt || "at an unknown time"}`)],
      unknowns,
    );
  }
  return out(
    STATES.OPEN,
    "clawdeck",
    "known",
    ["open, with nothing observed locally"],
    evidence,
    unknowns,
  );
}

function out(state, authority, certainty, reasons, evidence, unknowns) {
  return {
    state,
    authority,
    certainty,
    reasons,
    evidence,
    unknowns: [...new Set(unknowns)],
  };
}

/** Counts for the snapshot summary. Resolution unknown is never "resolved". */
export function summarizeStates(items) {
  const counts = {
    total: items.length,
    remoteResolved: 0,
    remoteUnresolved: 0,
    resolutionUnknown: 0,
    unread: 0,
    needsHuman: 0,
    replyDrafted: 0,
    likelyAddressed: 0,
    locallyChanged: 0,
  };
  for (const it of items) {
    const resolved = it.thread?.remote?.resolved;
    if (resolved === true) counts.remoteResolved++;
    else if (resolved === false) counts.remoteUnresolved++;
    else counts.resolutionUnknown++;

    switch (it.derived?.state) {
      case STATES.UNREAD:
        counts.unread++;
        break;
      case STATES.NEEDS_HUMAN:
        counts.needsHuman++;
        break;
      case STATES.REPLY_DRAFTED:
        counts.replyDrafted++;
        break;
      case STATES.LIKELY_ADDRESSED:
        counts.likelyAddressed++;
        break;
      case STATES.LOCALLY_CHANGED:
        counts.locallyChanged++;
        break;
      default:
        break;
    }
  }
  return counts;
}
