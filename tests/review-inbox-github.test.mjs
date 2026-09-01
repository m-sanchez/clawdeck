// @ts-check
/**
 * GitHub review-thread normalization. The load-bearing claims: resolution is
 * unknown (not false) without GraphQL, PR conversation comments are never
 * review threads, and the two coverage axes move independently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { githubReviewThreads } from "../server/forge/github-reviews.mjs";
import {
  FORGE,
  ghGraphqlPage,
  ghIssueComment,
  ghReviewComment,
  ghThreadNode,
  stubFetch,
} from "./helpers/review-thread-fixture.mjs";

const MR = { iid: 184 };

test("without a token, resolution is unknown and GraphQL is never called", async () => {
  const fetchImpl = stubFetch({
    "/pulls/184/comments": [ghReviewComment()],
    "/issues/184/comments": [],
  });
  const r = await githubReviewThreads(FORGE, null, MR, { fetchImpl });

  assert.equal(r.ok, true);
  assert.equal(r.threads.length, 1);
  assert.equal(r.threads[0].remote.resolved, null, "never false");
  assert.equal(r.threads[0].remote.resolvable, true);
  assert.equal(r.threads[0].remote.outdated, null);
  assert.equal(r.threads[0].remote.source, "rest");
  assert.equal(r.coverage.resolution.complete, false);
  assert.equal(
    fetchImpl.calls.some((c) => c.url.includes("/graphql")),
    false,
    "an anonymous GraphQL request is a guaranteed 401",
  );
  assert.ok(r.degraded.includes("github-graphql-requires-token"));
});

test("replies collapse into one thread keyed by the root comment", async () => {
  const fetchImpl = stubFetch({
    "/pulls/184/comments": [
      ghReviewComment({ id: 1001 }),
      ghReviewComment({
        id: 1002,
        in_reply_to_id: 1001,
        user: { login: "miguel" },
        body: "Fixed in the next commit.",
        created_at: "2026-09-01T12:00:00Z",
      }),
      ghReviewComment({ id: 2001, path: "src/cache.ts", line: 191 }),
    ],
    "/issues/184/comments": [],
  });
  const r = await githubReviewThreads(FORGE, null, MR, { fetchImpl });

  assert.equal(r.threads.length, 2);
  const withReply = r.threads.find((t) => t.remoteThreadId === "1001");
  assert.equal(withReply.comments.length, 2);
  assert.equal(withReply.comments[0].author, "sarah");
  assert.equal(withReply.comments[1].author, "miguel");
});

test("GraphQL enrichment joins on the root comment's databaseId", async () => {
  const fetchImpl = stubFetch({
    "/pulls/184/comments": [ghReviewComment({ id: 1001 })],
    "/issues/184/comments": [],
    "/graphql": ghGraphqlPage([
      ghThreadNode(1001, {
        isResolved: true,
        isOutdated: true,
        resolvedBy: { login: "sarah" },
      }),
    ]),
  });
  const r = await githubReviewThreads(FORGE, "tok", MR, { fetchImpl });

  assert.equal(r.threads[0].remote.resolved, true);
  assert.equal(r.threads[0].remote.outdated, true);
  assert.equal(r.threads[0].remote.resolvedBy, "sarah");
  assert.equal(r.threads[0].remote.source, "graphql");
  assert.equal(r.reviewDecision, "REVIEW_REQUIRED");
  assert.equal(r.coverage.resolution.complete, true);

  const gql = fetchImpl.calls.find((c) => c.url.includes("/graphql"));
  assert.equal(gql.method, "POST", "GraphQL reads are POST by protocol");
  assert.match(
    String(gql.init.body),
    /^\{"query":"query ClawdeckReviewThreads/,
  );
});

test("a GraphQL failure degrades to unknown resolution, never to false", async () => {
  const fetchImpl = stubFetch({
    "/pulls/184/comments": [ghReviewComment()],
    "/issues/184/comments": [],
    "/graphql": { status: 502 },
  });
  const r = await githubReviewThreads(FORGE, "tok", MR, { fetchImpl });

  assert.equal(r.ok, true);
  assert.equal(r.threads[0].remote.resolved, null);
  assert.ok(r.degraded.includes("github-graphql-unavailable"));
  assert.equal(r.coverage.resolution.complete, false);
});

test("thread coverage and resolution coverage move independently", async () => {
  // Two threads listed, only one enriched: the list is complete, the
  // resolution knowledge is not.
  const fetchImpl = stubFetch({
    "/pulls/184/comments": [
      ghReviewComment({ id: 1001 }),
      ghReviewComment({ id: 2001, path: "src/cache.ts" }),
    ],
    "/issues/184/comments": [],
    "/graphql": ghGraphqlPage([ghThreadNode(1001, { isResolved: true })]),
  });
  const r = await githubReviewThreads(FORGE, "tok", MR, { fetchImpl });

  assert.equal(r.coverage.threads.complete, true);
  assert.equal(r.coverage.resolution.complete, false);
  assert.equal(
    r.threads.find((t) => t.remoteThreadId === "2001").remote.resolved,
    null,
  );
});

test("PR conversation comments become notes, never review threads", async () => {
  const fetchImpl = stubFetch({
    "/pulls/184/comments": [],
    "/issues/184/comments": [ghIssueComment()],
  });
  const r = await githubReviewThreads(FORGE, null, MR, { fetchImpl });

  assert.equal(r.threads.length, 0);
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0].kind, "conversation-note");
  assert.equal(r.notes[0].location, null);
  assert.equal("remote" in r.notes[0], false, "a note has no resolution state");
});

test("the anchor keeps its line and commit in the same frame", async () => {
  // GitHub reports two frames: `line` measured on `commit_id` (the newest
  // commit it could map the comment to) and `original_line` measured on
  // `original_commit_id`. Pairing a line from one with a commit from the other
  // maps the anchor twice and lands on a line nobody reviewed - the exact
  // defect a real PR surfaced.
  const fetchImpl = stubFetch({
    "/pulls/184/comments": [
      ghReviewComment({
        id: 1001,
        line: 13,
        original_line: 10,
        commit_id: "newsha1",
        original_commit_id: "oldsha1",
      }),
      // Not mappable forward any more: only the original frame is usable.
      ghReviewComment({
        id: 2001,
        line: null,
        original_line: 24,
        commit_id: "oldsha1",
        original_commit_id: "oldsha1",
      }),
    ],
    "/issues/184/comments": [],
  });
  const r = await githubReviewThreads(FORGE, null, MR, { fetchImpl });

  const current = r.threads.find((t) => t.remoteThreadId === "1001");
  assert.equal(current.location.line, 13);
  assert.equal(
    current.location.anchorCommitSha,
    "newsha1",
    "line 13 is measured on the newer commit, so that is its anchor",
  );

  const outdated = r.threads.find((t) => t.remoteThreadId === "2001");
  assert.equal(outdated.location.line, 24);
  assert.equal(outdated.location.anchorCommitSha, "oldsha1");
});

test("pagination stops at the cap and marks the collection incomplete", async () => {
  const page = Array.from({ length: 100 }, (_, i) =>
    ghReviewComment({ id: 3000 + i }),
  );
  const fetchImpl = stubFetch({
    "/pulls/184/comments": page,
    "/issues/184/comments": [],
  });
  const r = await githubReviewThreads(FORGE, null, MR, { fetchImpl });

  assert.equal(r.coverage.threads.complete, false);
  assert.equal(r.coverage.threads.reason, "pagination cap");
  const pages = fetchImpl.calls.filter((c) =>
    c.url.includes("/pulls/184/comments"),
  );
  assert.equal(pages.length, 5);
  // Page URLs are built locally, so a hostile Link header cannot redirect us.
  for (const [i, c] of pages.entries())
    assert.ok(
      c.url.startsWith(`${FORGE.apiBase}/repos/o/r/pulls/184/comments?`) &&
        c.url.includes(`page=${i + 1}`),
    );
});

test("every request is a GET except the GraphQL query", async () => {
  const fetchImpl = stubFetch({
    "/pulls/184/comments": [ghReviewComment()],
    "/issues/184/comments": [ghIssueComment()],
    "/graphql": ghGraphqlPage([ghThreadNode(1001)]),
  });
  await githubReviewThreads(FORGE, "tok", MR, { fetchImpl });

  for (const call of fetchImpl.calls) {
    if (call.url.includes("/graphql")) assert.equal(call.method, "POST");
    else assert.equal(call.method, "GET");
  }
});

test("a failed listing degrades without throwing", async () => {
  const fetchImpl = stubFetch({ "/pulls/184/comments": { status: 500 } });
  const r = await githubReviewThreads(FORGE, null, MR, { fetchImpl });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "fetch-failed");
  assert.deepEqual(r.threads, []);
  assert.equal(r.coverage.threads.complete, false);
});
