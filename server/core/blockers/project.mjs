// @ts-check
/**
 * Everything standing between this branch and a shipped change, as one list.
 *
 * Each blocker answers two questions separately, because they are different
 * questions and one boolean cannot hold both: can the REMOTE change merge, and
 * has all the LOCAL work actually reached it? A dirty worktree blocks the
 * second and not the first; a missing approval blocks the first and not the
 * second. Collapsing them makes "you have uncommitted files" read as "GitHub
 * refuses to merge", which is false and unhelpful.
 *
 * `blocking` is tri-state per axis. `"unknown"` is not a hedge: it is what an
 * unread branch-protection policy or an unavailable provider actually leaves
 * behind, and it must not be rounded down to `false`.
 */

export const AXES = Object.freeze(["remoteMerge", "localDelivery"]);

const blocker = ({
  id,
  kind,
  title,
  detail = null,
  authority,
  remoteMerge = false,
  localDelivery = false,
  reasonRemote,
  reasonLocal,
  evidence = [],
  needsHuman = false,
  freshness = "fresh",
  coverage,
  links = {},
}) => ({
  id,
  kind,
  title,
  detail,
  authority,
  blocking: { remoteMerge, localDelivery },
  blockingReason: {
    ...(reasonRemote ? { remoteMerge: reasonRemote } : {}),
    ...(reasonLocal ? { localDelivery: reasonLocal } : {}),
  },
  evidence,
  needsHuman,
  freshness,
  ...(coverage ? { coverage } : {}),
  links,
});

/**
 * Project a snapshot into blockers.
 * @param {object} snapshot
 * @returns {object[]}
 */
export function projectBlockers(snapshot) {
  const out = [];
  const checkout = snapshot?.checkout || {};
  const forge = snapshot?.forge || {};
  const inbox = snapshot?.reviewInbox || {};
  const ci = snapshot?.ci || null;

  // ── Remote review threads ────────────────────────────────────────────────
  if (inbox.available && inbox.counts) {
    const { remoteUnresolved, resolutionUnknown } = inbox.counts;
    if (remoteUnresolved > 0)
      out.push(
        blocker({
          id: "review-threads-unresolved",
          kind: "review-thread",
          title: `${remoteUnresolved} unresolved review thread(s)`,
          authority: "forge",
          remoteMerge: true,
          reasonRemote: "the provider reports these threads unresolved",
          evidence: [{ kind: "forge", note: "remote.resolved = false" }],
          freshness: inbox.freshness ?? "unknown",
          coverage: inbox.coverage?.resolution,
          links: { changeId: inbox.mrIid ?? null },
        }),
      );
    if (resolutionUnknown > 0)
      out.push(
        blocker({
          id: "review-threads-unknown",
          kind: "review-thread",
          title: `${resolutionUnknown} thread(s) of unknown resolution`,
          detail: inbox.coverage?.resolution?.reason ?? null,
          authority: "forge",
          // Not knowing is not the same as being blocked, and not the same as
          // being clear either.
          remoteMerge: "unknown",
          reasonRemote: "the provider did not report a resolution state",
          evidence: [{ kind: "forge", note: "remote.resolved = null" }],
          freshness: inbox.freshness ?? "unknown",
          coverage: inbox.coverage?.resolution,
        }),
      );
  }

  // ── CI ───────────────────────────────────────────────────────────────────
  if (ci?.summary) {
    const s = ci.summary;
    if (s.state === "failing")
      out.push(
        blocker({
          id: "ci-failing",
          kind: "ci-failure",
          title: `${s.counts.failing} failing check(s)`,
          detail: (ci.failures || []).map((f) => f.name).join(", ") || null,
          authority: "ci",
          remoteMerge: true,
          localDelivery: true,
          reasonRemote: "a required check is failing",
          reasonLocal: "the change does not pass its own checks",
          evidence: (ci.failures || []).slice(0, 5).map((f) => ({
            kind: "ci",
            note: `${f.name} failed`,
            ref: f.detailsUrl,
          })),
          freshness: ci.freshness ?? "fresh",
          coverage: s.coverage,
        }),
      );
    else if (s.state === "unknown" || s.coverage?.complete === false)
      out.push(
        blocker({
          id: "ci-unknown",
          kind: "ci-failure",
          title: "CI state could not be established",
          detail: s.coverage?.reason ?? null,
          authority: "ci",
          remoteMerge: "unknown",
          localDelivery: "unknown",
          reasonRemote: "not every check context could be read",
          evidence: [
            { kind: "ci", note: s.coverage?.reason ?? "incomplete read" },
          ],
          freshness: ci.freshness ?? "unknown",
          coverage: s.coverage,
        }),
      );
    else if (s.state === "pending")
      out.push(
        blocker({
          id: "ci-pending",
          kind: "ci-failure",
          title: `${s.counts.pending} check(s) still running`,
          authority: "ci",
          remoteMerge: "unknown",
          reasonRemote: "checks have not finished",
          freshness: ci.freshness ?? "fresh",
          coverage: s.coverage,
        }),
      );
  }

  // ── Approvals and mergeability, from provider policy only ────────────────
  if (forge.configured && forge.mr) {
    const decision = inbox.reviewDecision ?? forge.reviewDecision ?? null;
    if (decision === "CHANGES_REQUESTED")
      out.push(
        blocker({
          id: "changes-requested",
          kind: "missing-approval",
          title: "Changes requested",
          authority: "forge",
          remoteMerge: true,
          reasonRemote: "the provider reports changes requested",
          needsHuman: true,
          evidence: [
            { kind: "forge", note: "reviewDecision = CHANGES_REQUESTED" },
          ],
        }),
      );
    else if (decision === "REVIEW_REQUIRED")
      out.push(
        blocker({
          id: "approval-required",
          kind: "missing-approval",
          title: "Review required",
          // The required count is only shown when a policy was actually read;
          // counting approvals is not the same as knowing the rule.
          detail: "required count: unknown",
          authority: "forge",
          remoteMerge: true,
          reasonRemote: "the provider requires a review before merge",
          needsHuman: true,
          evidence: [
            { kind: "forge", note: "reviewDecision = REVIEW_REQUIRED" },
          ],
        }),
      );
    else if (decision == null)
      out.push(
        blocker({
          id: "approval-unknown",
          kind: "missing-approval",
          title: "Approval state unknown",
          authority: "forge",
          remoteMerge: "unknown",
          reasonRemote: "the provider's review decision could not be read",
        }),
      );

    const merge = snapshot?.mergeability || null;
    const conflicts = merge?.hasConflicts ?? forge.mr.hasConflicts ?? null;
    if (conflicts === true)
      out.push(
        blocker({
          id: "merge-conflict",
          kind: "merge-conflict",
          title: "Merge conflicts",
          detail: merge?.status ? `provider status: ${merge.status}` : null,
          authority: "forge",
          remoteMerge: true,
          localDelivery: true,
          reasonRemote: "the provider reports conflicts with the target branch",
          reasonLocal: "the branch needs a rebase or merge locally",
          needsHuman: true,
          evidence: merge?.reason ? [{ kind: "forge", note: merge.reason }] : [],
        }),
      );

    // The provider's own policy, which is a different fact from the review
    // list: two approvals prove nothing about a rule requiring three.
    if (merge?.ok && merge.mergeable === false && conflicts !== true)
      out.push(
        blocker({
          id: "provider-refuses-merge",
          kind: "merge-policy",
          title: "The provider will not merge this yet",
          detail: merge.status ? `status: ${merge.status}` : null,
          authority: "forge",
          remoteMerge: true,
          reasonRemote: merge.reason ?? "the provider reports it is not mergeable",
          needsHuman: true,
          evidence: [{ kind: "forge", note: merge.reason ?? "not mergeable" }],
        }),
      );
    else if (!merge?.ok)
      out.push(
        blocker({
          id: "merge-policy-unknown",
          kind: "merge-policy",
          title: "Merge policy not read",
          detail: merge?.reason ?? "the provider was not asked",
          authority: "forge",
          remoteMerge: "unknown",
          reasonRemote: "whether the provider will merge has not been established",
        }),
      );

    if (merge?.blockingDiscussionsResolved === false)
      out.push(
        blocker({
          id: "discussions-block-merge",
          kind: "merge-policy",
          title: "Unresolved discussions block merge by project policy",
          authority: "forge",
          remoteMerge: true,
          reasonRemote: "the project requires every discussion resolved",
          needsHuman: true,
          evidence: [
            { kind: "forge", note: "blocking_discussions_resolved = false" },
          ],
        }),
      );
  }

  // ── Local state ──────────────────────────────────────────────────────────
  // `dirty` is a boolean; the count is its own field, and Number(true) is 1 -
  // which reads as "one uncommitted file" no matter how many there are.
  const dirty = Number(checkout.dirtyCount ?? (checkout.dirty ? 1 : 0));
  if (dirty > 0)
    out.push(
      blocker({
        id: "dirty-worktree",
        kind: "dirty-worktree",
        title: `${dirty} uncommitted file(s)`,
        authority: "git",
        // The remote knows nothing about your working tree.
        remoteMerge: false,
        localDelivery: true,
        reasonLocal: "work exists locally that is not in any commit",
        evidence: [{ kind: "git", note: "git status reports a dirty tree" }],
      }),
    );

  const ahead = Number(checkout.ahead ?? 0);
  if (ahead > 0)
    out.push(
      blocker({
        id: "unpushed-commits",
        kind: "unpushed-commits",
        title: `${ahead} commit(s) not pushed`,
        authority: "git",
        remoteMerge: false,
        localDelivery: true,
        reasonLocal: "local commits are not represented in the change",
        evidence: [
          { kind: "git", note: `HEAD is ${ahead} ahead of its upstream` },
        ],
      }),
    );

  const behind = Number(checkout.behind ?? 0);
  if (behind > 0) {
    // Being behind blocks a merge only where the provider says so. Read, it is
    // a fact; unread, it stays unknown rather than assumed either way.
    const behindBlocks = snapshot?.mergeability?.behindBlocks ?? null;
    out.push(
      blocker({
        id: "branch-behind",
        kind: "branch-behind",
        title: `${behind} commit(s) behind the target`,
        authority: behindBlocks == null ? "git" : "forge",
        remoteMerge: behindBlocks === true ? true : behindBlocks === false ? false : "unknown",
        reasonRemote:
          behindBlocks === true
            ? "the provider requires the branch to be up to date"
            : behindBlocks === false
              ? null
              : "whether the provider requires an up-to-date branch is unknown",
        localDelivery: false,
      }),
    );
  }

  return out;
}

/**
 * Fold blockers into one axis verdict.
 *
 * READY needs every known requirement satisfied AND nothing unknown left over.
 * BLOCKED needs a positive blocker. Anything else is UNKNOWN - the difference
 * between "you cannot merge" and "I cannot show that you can".
 */
export function readinessFor(axis, blockers, opts = {}) {
  const relevant = blockers.filter((b) => b.blocking[axis] !== false);
  const blocked = relevant.filter((b) => b.blocking[axis] === true);
  const unknown = relevant.filter((b) => b.blocking[axis] === "unknown");
  // Staleness is checked at the SOURCE as well as on blockers: a change with
  // nothing blocking has no blocker to carry it, and "no blockers found in data
  // from an hour ago" is not the same as "nothing is blocking".
  const stale = blockers.filter((b) => b.freshness === "stale");
  const staleSources = opts.staleSources ?? [];

  const state = blocked.length
    ? "BLOCKED"
    : unknown.length ||
        stale.length ||
        staleSources.length ||
        opts.missingEvidence
      ? "UNKNOWN"
      : "READY";

  return {
    state,
    blocking: blocked.map((b) => ({
      id: b.id,
      title: b.title,
      reason: b.blockingReason[axis],
    })),
    unknown: [
      ...unknown.map((b) => ({
        id: b.id,
        title: b.title,
        reason: b.blockingReason[axis],
      })),
      ...stale
        .filter((b) => !unknown.includes(b))
        .map((b) => ({
          id: b.id,
          title: b.title,
          reason: "the evidence is stale",
        })),
      ...staleSources.map((name) => ({
        id: `stale:${name}`,
        title: `${name} evidence is stale`,
        reason: "the provider has not been readable recently",
      })),
      ...(opts.missingEvidence
        ? [
            {
              id: "evidence-missing",
              title: opts.missingEvidence,
              reason: opts.missingEvidence,
            },
          ]
        : []),
    ],
  };
}

/** Both axes, plus a headline that never hides which one is at fault. */
export function deriveReadiness(snapshot) {
  const blockers = projectBlockers(snapshot);
  const inbox = snapshot?.reviewInbox || {};
  const ci = snapshot?.ci || null;

  // Which sources the remote answer leans on, and whether each is fresh enough
  // to lean on. The local axis rests on git, which is read directly every time.
  const staleRemote = [];
  if (inbox.configured && inbox.freshness === "stale")
    staleRemote.push("review thread");
  if (ci?.summary && ci.freshness === "stale") staleRemote.push("CI");

  // With no open change there is nothing to merge, so there is also nothing to
  // call ready: an empty blocker list here means "no PR", not "cleared".
  const forge = snapshot?.forge || {};
  const noChange = forge.configured && !forge.mr;
  const remote = readinessFor("remoteMerge", blockers, {
    staleSources: staleRemote,
    missingEvidence: noChange
      ? "no open change on the provider"
      : inbox.configured && !inbox.available
        ? "review threads could not be read"
        : null,
  });
  const local = readinessFor("localDelivery", blockers, {
    staleSources: ci?.summary && ci.freshness === "stale" ? ["CI"] : [],
  });
  const headline =
    remote.state === "BLOCKED" || local.state === "BLOCKED"
      ? "BLOCKED"
      : remote.state === "UNKNOWN" || local.state === "UNKNOWN"
        ? "UNKNOWN"
        : "READY";

  return { headline, remoteMerge: remote, localDelivery: local, blockers };
}
