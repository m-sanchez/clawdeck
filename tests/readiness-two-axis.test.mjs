// @ts-check
/**
 * Two-axis readiness.
 *
 * The point of separating the axes: "you have uncommitted files" must never
 * read as "the provider refuses to merge". And UNKNOWN is a real answer -
 * knowing you cannot merge is different from being unable to show that you can.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveReadiness,
  projectBlockers,
  readinessFor,
} from "../server/core/blockers/project.mjs";

const clean = {
  checkout: { dirty: 0, ahead: 0, behind: 0 },
  forge: {
    configured: true,
    mr: { iid: 7, state: "opened", hasConflicts: false },
  },
  reviewInbox: {
    configured: true,
    available: true,
    freshness: "fresh",
    reviewDecision: "APPROVED",
    coverage: { threads: { complete: true }, resolution: { complete: true } },
    counts: {
      total: 2,
      remoteResolved: 2,
      remoteUnresolved: 0,
      resolutionUnknown: 0,
      unread: 0,
      needsHuman: 0,
      replyDrafted: 0,
      likelyAddressed: 0,
      locallyChanged: 0,
    },
  },
  ci: {
    freshness: "fresh",
    summary: {
      state: "passing",
      coverage: { complete: true },
      counts: { total: 3, passing: 3, failing: 0, pending: 0 },
    },
    failures: [],
  },
  // The provider's own verdict. Without it there is no basis for READY, which
  // is what the "policy not read" test below pins.
  mergeability: {
    ok: true,
    provider: "github",
    mergeable: true,
    hasConflicts: false,
    blockingDiscussionsResolved: true,
    status: "clean",
    behindBlocks: false,
    reason: "mergeable_state = clean",
  },
};

const withCheckout = (over) => ({
  ...clean,
  checkout: { ...clean.checkout, ...over },
});

test("a clean, fully-known change is READY on both axes", () => {
  const r = deriveReadiness(clean);
  assert.equal(r.headline, "READY");
  assert.equal(r.remoteMerge.state, "READY");
  assert.equal(r.localDelivery.state, "READY");
});

test("a dirty tree blocks local delivery and not the remote merge", () => {
  const r = deriveReadiness(withCheckout({ dirty: 2 }));
  assert.equal(
    r.remoteMerge.state,
    "READY",
    "the provider knows nothing about it",
  );
  assert.equal(r.localDelivery.state, "BLOCKED");
  assert.match(r.localDelivery.blocking[0].reason, /not in any commit/);
  assert.equal(r.headline, "BLOCKED");
});

test("unpushed commits block local delivery only", () => {
  const r = deriveReadiness(withCheckout({ ahead: 1 }));
  assert.equal(r.remoteMerge.state, "READY");
  assert.equal(r.localDelivery.state, "BLOCKED");
});

test("an unresolved review thread blocks the remote merge only", () => {
  const r = deriveReadiness({
    ...clean,
    reviewInbox: {
      ...clean.reviewInbox,
      counts: {
        ...clean.reviewInbox.counts,
        remoteResolved: 1,
        remoteUnresolved: 1,
      },
    },
  });
  assert.equal(r.remoteMerge.state, "BLOCKED");
  assert.equal(r.localDelivery.state, "READY", "nothing local is outstanding");
});

test("a failing check blocks both axes", () => {
  const r = deriveReadiness({
    ...clean,
    ci: {
      freshness: "fresh",
      summary: {
        state: "failing",
        coverage: { complete: true },
        counts: { total: 3, passing: 2, failing: 1, pending: 0 },
      },
      failures: [{ name: "windows / node 22", detailsUrl: "https://x" }],
    },
  });
  assert.equal(r.remoteMerge.state, "BLOCKED");
  assert.equal(r.localDelivery.state, "BLOCKED");
});

test("branch-behind is unknown until the policy is read, never assumed", () => {
  const r = deriveReadiness({
    ...withCheckout({ behind: 3 }),
    // The provider answered, but said nothing about an up-to-date-branch rule.
    mergeability: { ...clean.mergeability, behindBlocks: null },
  });
  assert.equal(r.remoteMerge.state, "UNKNOWN");
  assert.equal(r.remoteMerge.blocking.length, 0, "nothing positive is claimed");
  assert.match(r.remoteMerge.unknown[0].reason, /up-to-date branch is unknown/);
  assert.equal(r.localDelivery.state, "READY");
});

test("unknown resolution keeps the remote axis unknown, not blocked", () => {
  const r = deriveReadiness({
    ...clean,
    reviewInbox: {
      ...clean.reviewInbox,
      coverage: {
        threads: { complete: true },
        resolution: { complete: false, reason: "needs a token" },
      },
      counts: {
        ...clean.reviewInbox.counts,
        remoteResolved: 1,
        resolutionUnknown: 1,
      },
    },
  });
  assert.equal(r.remoteMerge.state, "UNKNOWN");
  assert.equal(r.headline, "UNKNOWN");
});

test("stale evidence can be shown but never mints READY", () => {
  const r = deriveReadiness({
    ...clean,
    reviewInbox: { ...clean.reviewInbox, freshness: "stale" },
    ci: { ...clean.ci, freshness: "stale" },
  });
  assert.notEqual(r.remoteMerge.state, "READY");
});

test("blocked and unknown together read as blocked, with the unknowns listed", () => {
  const r = deriveReadiness({
    ...withCheckout({ behind: 2 }),
    mergeability: { ...clean.mergeability, behindBlocks: null },
    ci: {
      freshness: "fresh",
      summary: {
        state: "failing",
        coverage: { complete: true },
        counts: { total: 2, passing: 1, failing: 1, pending: 0 },
      },
      failures: [{ name: "lint" }],
    },
  });
  assert.equal(r.remoteMerge.state, "BLOCKED");
  assert.ok(r.remoteMerge.blocking.length >= 1);
  assert.ok(
    r.remoteMerge.unknown.some((u) => /up-to-date branch/.test(u.reason)),
    "the unknown is still reported beside the blocker",
  );
});

test("approvals come from the provider's decision, never from counting reviews", () => {
  const required = deriveReadiness({
    ...clean,
    reviewInbox: { ...clean.reviewInbox, reviewDecision: "REVIEW_REQUIRED" },
  });
  const b = required.blockers.find((x) => x.kind === "missing-approval");
  assert.equal(b.detail, "required count: unknown");
  assert.equal(b.needsHuman, true);
  assert.equal(required.remoteMerge.state, "BLOCKED");

  const unknown = deriveReadiness({
    ...clean,
    reviewInbox: { ...clean.reviewInbox, reviewDecision: null },
    forge: { ...clean.forge },
  });
  assert.equal(unknown.remoteMerge.state, "UNKNOWN");
});

test("every blocker declares both axes with a reason for the ones it blocks", () => {
  const blockers = projectBlockers({
    ...withCheckout({ dirty: 1, ahead: 1, behind: 1 }),
    ci: {
      summary: {
        state: "failing",
        coverage: { complete: true },
        counts: { total: 1, passing: 0, failing: 1, pending: 0 },
      },
      failures: [{ name: "unit" }],
    },
  });
  assert.ok(blockers.length >= 4);
  for (const b of blockers) {
    for (const axis of ["remoteMerge", "localDelivery"])
      assert.ok(
        [true, false, "unknown"].includes(b.blocking[axis]),
        `${b.id}.${axis} must be tri-state`,
      );
    for (const axis of ["remoteMerge", "localDelivery"])
      if (b.blocking[axis] === true)
        assert.ok(
          b.blockingReason[axis],
          `${b.id} must say why it blocks ${axis}`,
        );
  }
});

test("readinessFor ignores blockers that do not touch its axis", () => {
  const only = readinessFor("remoteMerge", [
    {
      id: "x",
      title: "dirty",
      blocking: { remoteMerge: false, localDelivery: true },
      blockingReason: { localDelivery: "local only" },
      freshness: "fresh",
    },
  ]);
  assert.equal(only.state, "READY");
});

test("with no open change, the remote axis is unknown rather than ready", () => {
  const r = deriveReadiness({
    ...clean,
    forge: { configured: true, mr: null },
    reviewInbox: { ...clean.reviewInbox, configured: false, available: false },
  });
  assert.equal(r.remoteMerge.state, "UNKNOWN");
  assert.match(r.remoteMerge.unknown[0].reason, /no open change/);
  assert.equal(r.localDelivery.state, "READY", "local work is still local work");
});

test("the uncommitted count is the file count, not the dirty flag", () => {
  const r = deriveReadiness({
    ...clean,
    checkout: { dirty: true, dirtyCount: 7, ahead: 0, behind: 0 },
  });
  assert.match(r.localDelivery.blocking[0].title, /7 uncommitted/);
});

test("an unread merge policy cannot leave the remote axis READY", () => {
  const r = deriveReadiness({ ...clean, mergeability: null });
  assert.equal(r.remoteMerge.state, "UNKNOWN");
  assert.ok(
    r.remoteMerge.unknown.some((u) => /will merge has not been established/.test(u.reason)),
  );
  assert.equal(r.localDelivery.state, "READY", "the local axis does not care");
});

test("the provider refusing to merge is a blocker in its own right", () => {
  const r = deriveReadiness({
    ...clean,
    mergeability: {
      ...clean.mergeability,
      mergeable: false,
      status: "blocked",
      reason: "mergeable_state = blocked",
    },
  });
  assert.equal(r.remoteMerge.state, "BLOCKED");
  const b = r.blockers.find((x) => x.id === "provider-refuses-merge");
  assert.equal(b.needsHuman, true);
  assert.match(b.blockingReason.remoteMerge, /mergeable_state = blocked/);
});

test("a provider still computing mergeability is unknown, not unmergeable", () => {
  const r = deriveReadiness({
    ...clean,
    mergeability: { ...clean.mergeability, mergeable: "unknown", status: null },
  });
  assert.equal(r.remoteMerge.state, "READY", "no positive refusal was reported");
  assert.ok(
    !r.blockers.some((b) => b.id === "provider-refuses-merge"),
    "an unknown answer must not be rendered as a refusal",
  );
});

test("a project rule requiring resolved discussions blocks, and says so", () => {
  const r = deriveReadiness({
    ...clean,
    mergeability: { ...clean.mergeability, blockingDiscussionsResolved: false },
  });
  const b = r.blockers.find((x) => x.id === "discussions-block-merge");
  assert.equal(r.remoteMerge.state, "BLOCKED");
  assert.match(b.blockingReason.remoteMerge, /every discussion resolved/);
});

test("behind the target blocks only where the provider states that rule", () => {
  const blocked = deriveReadiness({
    ...withCheckout({ behind: 2 }),
    mergeability: { ...clean.mergeability, behindBlocks: true, status: "behind" },
  });
  const b = blocked.blockers.find((x) => x.id === "branch-behind");
  assert.equal(b.authority, "forge", "this is the provider's rule, not git's");
  assert.equal(blocked.remoteMerge.state, "BLOCKED");

  const fine = deriveReadiness({
    ...withCheckout({ behind: 2 }),
    mergeability: { ...clean.mergeability, behindBlocks: false },
  });
  assert.equal(fine.remoteMerge.state, "READY");
});

test("conflicts reported by the policy read outrank a stale list field", () => {
  const r = deriveReadiness({
    ...clean,
    forge: { ...clean.forge, mr: { ...clean.forge.mr, hasConflicts: null } },
    mergeability: {
      ...clean.mergeability,
      mergeable: false,
      hasConflicts: true,
      status: "dirty",
    },
  });
  assert.ok(r.blockers.some((b) => b.id === "merge-conflict"));
  assert.ok(
    !r.blockers.some((b) => b.id === "provider-refuses-merge"),
    "one cause, one blocker",
  );
});
