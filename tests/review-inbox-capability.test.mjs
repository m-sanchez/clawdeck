// @ts-check
/**
 * Capabilities and the off switch.
 *
 * The load-bearing rule: write capability is derived from what the provider
 * answered, never from a token being present. A token can be read-only, and a
 * later write gate must refuse anything it has not positively observed.
 *
 * The toggle matters for a different reason: "off" has to mean zero requests,
 * not a quieter poll.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capabilitiesFromObservations,
  parseScopeHeader,
} from "../server/forge/capabilities.mjs";
import { githubReviewThreads } from "../server/forge/github-reviews.mjs";
import { getReviewInbox } from "../server/adapters/review-inbox.mjs";
import {
  FORGE,
  ghReviewComment,
  stubFetch,
} from "./helpers/review-thread-fixture.mjs";

const dirs = [];
let runtime = "";
beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), "clawdeck-cap-"));
  dirs.push(runtime);
});
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("a token alone never grants write capability", () => {
  const caps = capabilitiesFromObservations("github", {
    authenticated: true,
    restStatus: 200,
    restComplete: true,
  });
  assert.equal(caps.auth, "token");
  assert.equal(caps.write.reply, "unknown", "no scope evidence means unknown");
  assert.equal(caps.write.resolve, "unknown");
  assert.equal(caps.read.threads, "ok");
});

test("scopes decide write capability in both directions", () => {
  const allowed = capabilitiesFromObservations("github", {
    authenticated: true,
    restStatus: 200,
    scopes: ["repo", "read:org"],
  });
  assert.equal(allowed.write.reply, "allowed");

  const forbidden = capabilitiesFromObservations("github", {
    authenticated: true,
    restStatus: 200,
    scopes: ["read:user"],
  });
  assert.equal(forbidden.write.reply, "forbidden", "known and insufficient");

  const gitlabReadOnly = capabilitiesFromObservations("gitlab", {
    authenticated: true,
    restStatus: 200,
    scopes: ["read_api"],
  });
  assert.equal(gitlabReadOnly.write.resolve, "forbidden");
});

test("read capability follows the payload, not the request", () => {
  const restOnly = capabilitiesFromObservations("github", {
    authenticated: false,
    restStatus: 200,
    restComplete: true,
  });
  assert.equal(restOnly.read.resolution, "unavailable");
  assert.equal(
    restOnly.read.outdated,
    "inferred",
    "our own heuristic, not theirs",
  );

  const enriched = capabilitiesFromObservations("github", {
    authenticated: true,
    restStatus: 200,
    graphqlStatus: 200,
    resolutionInPayload: true,
    outdatedInPayload: true,
  });
  assert.equal(enriched.read.resolution, "ok");
  assert.equal(enriched.read.outdated, "ok");

  const partial = capabilitiesFromObservations("github", {
    restStatus: 200,
    restComplete: false,
  });
  assert.equal(partial.read.threads, "partial");

  const denied = capabilitiesFromObservations("github", { restStatus: 403 });
  assert.equal(denied.read.threads, "unavailable");
  assert.ok(denied.evidence.includes("rest:403"));
});

test("absent rate-limit headers read as null, never zero", () => {
  const caps = capabilitiesFromObservations("github", { restStatus: 200 });
  assert.equal(caps.rateLimit.remaining, null);
  assert.equal(caps.rateLimit.resetAt, null);

  const withBudget = capabilitiesFromObservations("github", {
    restStatus: 200,
    rateLimitRemaining: "37",
    rateLimitReset: "1790000000",
  });
  assert.equal(withBudget.rateLimit.remaining, 37);
  assert.match(withBudget.rateLimit.resetAt, /^20\d\d-/);
});

test("the scope header parses, and its absence is null rather than empty", () => {
  assert.deepEqual(parseScopeHeader("repo, read:org"), ["repo", "read:org"]);
  assert.deepEqual(parseScopeHeader(""), []);
  assert.equal(
    parseScopeHeader(null),
    null,
    "a fine-grained PAT sends no header",
  );
});

test("a live read reports capabilities derived from the response", async () => {
  const fetchImpl = stubFetch({
    "/pulls/184/comments": [ghReviewComment()],
    "/issues/184/comments": [],
  });
  const r = await githubReviewThreads(FORGE, null, { iid: 184 }, { fetchImpl });

  assert.equal(r.capabilities.provider, "github");
  assert.equal(r.capabilities.auth, "none");
  assert.equal(r.capabilities.read.threads, "ok");
  assert.equal(r.capabilities.read.resolution, "unavailable");
  assert.equal(r.capabilities.write.reply, "unknown");
});

test("the toggle off means zero requests, and the snapshot still builds", async () => {
  const fetchImpl = () => {
    throw new Error("a disabled inbox must not touch the network");
  };
  const inbox = await getReviewInbox(
    { checkoutRoot: runtime, runtimeDir: runtime },
    { mr: { iid: 184, state: "opened" }, enabled: false },
    { fetchImpl },
  );

  assert.equal(inbox.available, false);
  assert.equal(inbox.reason, "disabled");
  assert.deepEqual(inbox.items, []);
  assert.match(inbox.detail, /turned off/);
});
