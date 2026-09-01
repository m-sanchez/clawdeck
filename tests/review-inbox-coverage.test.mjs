// @ts-check
/**
 * Absence requires coverage. Zero unresolved threads means "clear" only when
 * the list was complete, the resolutions were actually read, and the data is
 * fresh - otherwise the honest answer is that we do not know yet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDelivery } from "../server/core/delivery/lifecycle.mjs";
import { summarizeInbox } from "../server/adapters/review-inbox.mjs";

const base = {
  checkout: { dirty: 0, ahead: 0 },
  validation: { passed: true, checks: [{ status: "passed" }] },
  reviews: { status: "ok", blockCount: 0 },
  readiness: { evidence: [{ label: "/pre-mr marker matches HEAD", ok: true }] },
  forge: {
    configured: true,
    mr: { iid: 184, state: "opened" },
    pipeline: { status: "success" },
  },
};

const inbox = (over = {}) => ({
  configured: true,
  available: true,
  provider: "github",
  freshness: "fresh",
  coverage: { threads: { complete: true }, resolution: { complete: true } },
  counts: {
    total: 3,
    remoteResolved: 3,
    remoteUnresolved: 0,
    resolutionUnknown: 0,
    unread: 0,
    needsHuman: 0,
    replyDrafted: 0,
    likelyAddressed: 0,
    locallyChanged: 0,
  },
  top: [],
  ...over,
});

const stageOf = (snapshot) =>
  deriveDelivery(snapshot).stages.find((s) => s.key === "reviewthreads");

test("all resolved, complete and fresh is the only way to reach done", () => {
  const s = stageOf({ ...base, reviewInbox: inbox() });
  assert.equal(s.state, "done");
});

test("an unresolved thread blocks delivery and names itself", () => {
  const snapshot = {
    ...base,
    reviewInbox: inbox({
      counts: { ...inbox().counts, remoteResolved: 1, remoteUnresolved: 2 },
    }),
  };
  assert.equal(stageOf(snapshot).state, "blocked");
  assert.ok(
    deriveDelivery(snapshot).blockers.some((b) =>
      /2 unresolved review thread/.test(b),
    ),
  );
});

test("unknown resolution is never done", () => {
  const s = stageOf({
    ...base,
    reviewInbox: inbox({
      counts: { ...inbox().counts, remoteResolved: 2, resolutionUnknown: 1 },
      coverage: {
        threads: { complete: true },
        resolution: { complete: false },
      },
    }),
  });
  assert.equal(s.state, "current");
  assert.match(s.detail, /unknown resolution/);
});

test("zero unresolved under an incomplete listing is not clear", () => {
  const s = stageOf({
    ...base,
    reviewInbox: inbox({
      coverage: {
        threads: { complete: false, reason: "pagination cap" },
        resolution: { complete: true },
      },
    }),
  });
  assert.equal(s.state, "current");
  assert.equal(s.state === "done", false, "thread 301 may be on page six");
});

test("stale data can be shown but cannot mint done", () => {
  const s = stageOf({ ...base, reviewInbox: inbox({ freshness: "stale" }) });
  assert.equal(s.state, "current");
  assert.match(s.detail, /provider currently unavailable|provider unavailable/);
});

test("no open change skips the stage instead of implying success", () => {
  const s = stageOf({
    ...base,
    reviewInbox: { configured: false, available: false, counts: null, top: [] },
  });
  assert.equal(s.state, "skipped");
});

test("a failed fetch is pending with its reason, never done", () => {
  const s = stageOf({
    ...base,
    reviewInbox: summarizeInbox({
      available: false,
      reason: "fetch-failed",
      detail: "HTTP 502",
      provider: "github",
    }),
  });
  assert.equal(s.state, "pending");
  assert.match(s.detail, /502/);
});

test("the snapshot summary never carries comment bodies", () => {
  const summary = summarizeInbox({
    available: true,
    provider: "github",
    mrIid: 184,
    observedAt: "2026-09-02T10:00:00Z",
    freshness: "fresh",
    coverage: { threads: { complete: true }, resolution: { complete: true } },
    counts: inbox().counts,
    items: [
      {
        thread: {
          id: "rt_" + "a".repeat(24),
          location: { file: "src/auth.ts", line: 84 },
          comments: [{ body: "SECRET REVIEW TEXT" }],
        },
        derived: { state: "UNREAD", authority: "human", certainty: "known" },
      },
    ],
  });
  const json = JSON.stringify(summary);
  assert.equal(json.includes("SECRET REVIEW TEXT"), false);
  assert.equal(summary.top[0].file, "src/auth.ts");
  assert.ok(json.length < 1024, "the snapshot projection stays small");
});
