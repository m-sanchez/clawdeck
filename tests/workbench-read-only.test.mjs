// @ts-check
/**
 * The Workbench introduces no forge mutation capability.
 *
 * Scoped deliberately: Clawdeck already has unrelated mutating actions
 * (`remote.deleteBranch`, `policy.approve`) that predate this feature and stay.
 * What must never appear is a Workbench-owned way to write to a forge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_NAMES } from "../server/lib/actions.mjs";
import {
  GITHUB_REVIEW_THREADS,
  operationType,
} from "../server/forge/graphql-queries.mjs";
import { githubReviewThreads } from "../server/forge/github-reviews.mjs";
import { gitlabReviewThreads } from "../server/forge/gitlab-reviews.mjs";
import {
  FORGE,
  GL_FORGE,
  ghGraphqlPage,
  ghIssueComment,
  ghReviewComment,
  ghThreadNode,
  glDiscussion,
  stubFetch,
} from "./helpers/review-thread-fixture.mjs";

const FORGE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "server",
  "forge",
);

const FORBIDDEN_ACTIONS = [
  "reviewInbox.reply",
  "reviewInbox.resolve",
  "forge.review.approve",
  "forge.merge",
];

test("no Workbench forge-write action is registered", () => {
  for (const name of FORBIDDEN_ACTIONS)
    assert.equal(
      ACTION_NAMES.includes(name),
      false,
      `${name} would give the Workbench a remote write`,
    );
});

test("pre-existing unrelated mutating actions are untouched", () => {
  // Guards the scoping itself: a future "tighten everything" sweep that deletes
  // these is a behaviour change, not a cleanup.
  assert.equal(ACTION_NAMES.includes("remote.deleteBranch"), true);
  assert.equal(ACTION_NAMES.includes("policy.approve"), true);
});

test("every GraphQL document under server/forge is a read-only query", () => {
  const files = readdirSync(FORGE_DIR).filter((f) => f.endsWith(".mjs"));
  for (const f of files) {
    const src = readFileSync(join(FORGE_DIR, f), "utf8");
    assert.equal(
      /\bmutation\s+\w*\s*[({]/.test(src),
      false,
      `${f} must not contain a GraphQL mutation document`,
    );
  }
  assert.equal(operationType(GITHUB_REVIEW_THREADS), "query");
});

test("review connectors issue GET only, except the GraphQL read", async () => {
  const gh = stubFetch({
    "/pulls/184/comments": [ghReviewComment()],
    "/issues/184/comments": [ghIssueComment()],
    "/graphql": ghGraphqlPage([ghThreadNode(1001)]),
  });
  await githubReviewThreads(FORGE, "tok", { iid: 184 }, { fetchImpl: gh });

  const gl = stubFetch({ "/discussions": [glDiscussion()] });
  await gitlabReviewThreads(GL_FORGE, "tok", { iid: 42 }, { fetchImpl: gl });

  for (const call of [...gh.calls, ...gl.calls]) {
    if (call.url.includes("/graphql")) {
      assert.equal(call.method, "POST");
      const body = JSON.parse(String(call.init.body));
      assert.equal(
        operationType(body.query),
        "query",
        "a POST is only acceptable while it carries a query",
      );
    } else {
      assert.equal(call.method, "GET", `${call.url} must be a read`);
    }
  }
});
