// @ts-check
/**
 * Merge policy comes from the provider, or it is unknown.
 *
 * The failure this guards: reading a review list, counting two approvals, and
 * telling someone their change can merge - when the rule required three, or a
 * specific team, or an up-to-date branch. None of that is visible from the
 * review list, so the question is asked of the party that knows.
 *
 * The second failure: GitHub answers `mergeable: null` while it is still
 * computing. That is unknown. Rendering it as "cannot merge" is a different
 * lie, in the other direction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  githubMergeability,
  gitlabMergeability,
} from "../server/forge/mergeability.mjs";
import {
  FORGE,
  GL_FORGE,
  stubFetch,
} from "./helpers/review-thread-fixture.mjs";

const pr = (over = {}) => ({
  "/pulls/7": { number: 7, mergeable: true, mergeable_state: "clean", ...over },
});
const mr = (over = {}) => ({
  "/merge_requests/7": {
    iid: 7,
    detailed_merge_status: "mergeable",
    has_conflicts: false,
    blocking_discussions_resolved: true,
    ...over,
  },
});

test("a clean GitHub PR is mergeable, with the provider's own status kept", async () => {
  const fetchImpl = stubFetch(pr());
  const r = await githubMergeability(FORGE, "tok", 7, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.mergeable, true);
  assert.equal(r.hasConflicts, false);
  assert.equal(r.status, "clean");
  assert.equal(r.behindBlocks, false);
});

test("mergeable null is unknown, never a refusal", async () => {
  const fetchImpl = stubFetch(
    pr({ mergeable: null, mergeable_state: "unknown" }),
  );
  const r = await githubMergeability(FORGE, "tok", 7, { fetchImpl });
  assert.equal(r.mergeable, "unknown");
  assert.equal(r.hasConflicts, null, "not computed is not 'no conflicts'");
});

test("a dirty state reports conflicts; behind reports the provider's rule", async () => {
  const dirty = await githubMergeability(FORGE, "tok", 7, {
    fetchImpl: stubFetch(pr({ mergeable: false, mergeable_state: "dirty" })),
  });
  assert.equal(dirty.hasConflicts, true);
  assert.equal(dirty.mergeable, false);

  const behind = await githubMergeability(FORGE, "tok", 7, {
    fetchImpl: stubFetch(pr({ mergeable: true, mergeable_state: "behind" })),
  });
  assert.equal(behind.behindBlocks, true);
  assert.match(behind.reason, /mergeable_state = behind/);
});

test("an unreadable answer is unknown with the reason, and never throws", async () => {
  const r = await githubMergeability(FORGE, "tok", 7, {
    fetchImpl: stubFetch({ "/pulls/7": { status: 403 } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.mergeable, "unknown");
  assert.match(r.reason, /403/);

  const thrown = await githubMergeability(FORGE, "tok", 7, {
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(thrown.mergeable, "unknown");
  assert.match(thrown.reason, /network down/);
});

test("no open change is unknown, not mergeable", async () => {
  const r = await githubMergeability(FORGE, "tok", null, {
    fetchImpl: stubFetch({}),
  });
  assert.equal(r.mergeable, "unknown");
  assert.match(r.reason, /no open change/);
});

test("GitLab reports its detailed status and its discussion rule", async () => {
  const ok = await gitlabMergeability(GL_FORGE, "tok", 7, {
    fetchImpl: stubFetch(mr()),
  });
  assert.equal(ok.mergeable, true);
  assert.equal(ok.blockingDiscussionsResolved, true);

  const blocked = await gitlabMergeability(GL_FORGE, "tok", 7, {
    fetchImpl: stubFetch(
      mr({
        detailed_merge_status: "discussions_not_resolved",
        blocking_discussions_resolved: false,
      }),
    ),
  });
  assert.equal(blocked.mergeable, false);
  assert.equal(blocked.blockingDiscussionsResolved, false);

  const rebase = await gitlabMergeability(GL_FORGE, "tok", 7, {
    fetchImpl: stubFetch(mr({ detailed_merge_status: "need_rebase" })),
  });
  assert.equal(rebase.behindBlocks, true);
});

test("GitLab without a token asks nothing and answers unknown", async () => {
  const fetchImpl = stubFetch(mr());
  const r = await gitlabMergeability(GL_FORGE, null, 7, { fetchImpl });
  assert.equal(r.mergeable, "unknown");
  assert.equal(fetchImpl.calls.length, 0);
});

test("both providers issue GETs only", async () => {
  const gh = stubFetch(pr());
  await githubMergeability(FORGE, "tok", 7, { fetchImpl: gh });
  const gl = stubFetch(mr());
  await gitlabMergeability(GL_FORGE, "tok", 7, { fetchImpl: gl });
  for (const call of [...gh.calls, ...gl.calls])
    assert.equal(call.method, "GET");
});
