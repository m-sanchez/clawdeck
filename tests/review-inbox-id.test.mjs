// @ts-check
/**
 * Thread identity. Marks, drafts, tasks and decisions all hang off this id, so
 * it must be deterministic, stable across a re-read and across the REST vs
 * GraphQL paths, and distinct for every distinct discussion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { threadId } from "../server/core/review-inbox/model.mjs";
import { githubReviewThreads } from "../server/forge/github-reviews.mjs";
import {
  FORGE,
  ghGraphqlPage,
  ghReviewComment,
  ghThreadNode,
  stubFetch,
} from "./helpers/review-thread-fixture.mjs";

test("the id is deterministic and shaped for the route validator", () => {
  const a = threadId("github", "o/r", "184", "12345");
  assert.equal(a, threadId("github", "o/r", "184", "12345"));
  assert.match(a, /^rt_[0-9a-f]{24}$/);
});

test("the id changes with provider, repository, change or thread", () => {
  const base = threadId("github", "o/r", "184", "12345");
  const others = [
    threadId("gitlab", "o/r", "184", "12345"),
    threadId("github", "o/other", "184", "12345"),
    threadId("github", "o/r", "185", "12345"),
    threadId("github", "o/r", "184", "12346"),
  ];
  assert.equal(new Set([base, ...others]).size, 5);
});

test("the id survives a re-poll and is identical with or without enrichment", async () => {
  const rest = {
    "/pulls/184/comments": [ghReviewComment({ id: 1001 })],
    "/issues/184/comments": [],
  };
  const first = await githubReviewThreads(
    FORGE,
    null,
    { iid: 184 },
    {
      fetchImpl: stubFetch(rest),
    },
  );
  const second = await githubReviewThreads(
    FORGE,
    null,
    { iid: 184 },
    {
      fetchImpl: stubFetch(rest),
    },
  );
  const enriched = await githubReviewThreads(
    FORGE,
    "tok",
    { iid: 184 },
    {
      fetchImpl: stubFetch({
        ...rest,
        "/graphql": ghGraphqlPage([ghThreadNode(1001, { isResolved: true })]),
      }),
    },
  );

  assert.equal(first.threads[0].id, second.threads[0].id);
  assert.equal(
    first.threads[0].id,
    enriched.threads[0].id,
    "enrichment must not re-key a thread and orphan its marks",
  );
  // A later reply must not change the thread's identity either.
  const withReply = await githubReviewThreads(
    FORGE,
    null,
    { iid: 184 },
    {
      fetchImpl: stubFetch({
        ...rest,
        "/pulls/184/comments": [
          ghReviewComment({ id: 1001 }),
          ghReviewComment({ id: 1002, in_reply_to_id: 1001 }),
        ],
      }),
    },
  );
  assert.equal(withReply.threads[0].id, first.threads[0].id);
});
