// @ts-check
/**
 * The Attention Inbox and the advisory boundary.
 *
 * Two failures this guards against. Attention drifting into a copy of the
 * delivery blocker list, so the badge counts uncommitted files and stops
 * meaning "a person is needed". And model output reaching the badge: an
 * assist's opinion must not be able to put anything in front of anyone until a
 * human clicks, and what lands then is the human's record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectAttention,
  projectSuggested,
} from "../server/core/attention/project.mjs";
import {
  promote,
  dismiss,
  readPromotions,
} from "../server/core/attention/store.mjs";
import { deriveReadiness } from "../server/core/blockers/project.mjs";

const base = {
  checkout: { dirty: 3, ahead: 2, behind: 0 },
  forge: { configured: true, mr: { iid: 7, hasConflicts: false } },
  reviewInbox: {
    configured: true,
    available: true,
    freshness: "fresh",
    reviewDecision: "APPROVED",
    coverage: { threads: { complete: true }, resolution: { complete: true } },
    counts: {
      total: 1,
      remoteResolved: 1,
      remoteUnresolved: 0,
      resolutionUnknown: 0,
      unread: 0,
      needsHuman: 0,
      replyDrafted: 0,
      likelyAddressed: 0,
      locallyChanged: 0,
    },
    top: [],
  },
  ci: {
    available: true,
    freshness: "fresh",
    observedAt: "2026-09-01T10:00:00Z",
    summary: {
      state: "passing",
      coverage: { complete: true },
      counts: { total: 2, passing: 2, failing: 0, pending: 0 },
    },
    failures: [],
  },
  tasks: { counts: null, recent: [] },
};
const withReadiness = (over = {}) => {
  const snap = { ...base, ...over };
  return { ...snap, deliveryReadiness: deriveReadiness(snap) };
};
const tmp = () => mkdtempSync(join(tmpdir(), "clawdeck-attention-"));

test("mechanical delivery blockers never reach attention", () => {
  const snap = withReadiness();
  const blockers = snap.deliveryReadiness.blockers.map((b) => b.id);
  assert.ok(
    blockers.includes("dirty-worktree") &&
      blockers.includes("unpushed-commits"),
    "the fixture really is blocked on local work",
  );

  const a = projectAttention(snap);
  assert.equal(a.counts.total, 0, "nobody's judgement is required for either");
});

test("a decision the provider is waiting on does reach attention", () => {
  const snap = withReadiness({
    reviewInbox: { ...base.reviewInbox, reviewDecision: "CHANGES_REQUESTED" },
  });
  const a = projectAttention(snap);
  assert.equal(a.counts.blocking, 1);
  assert.equal(a.items[0].kind, "missing-approval");
  assert.equal(a.items[0].authority, "forge");
});

test("a failing check needs a person and says which checks", () => {
  const snap = withReadiness({
    ci: {
      ...base.ci,
      summary: {
        state: "failing",
        coverage: { complete: true },
        counts: { total: 2, passing: 1, failing: 1, pending: 0 },
      },
      failures: [{ name: "windows / node 22" }],
    },
  });
  const a = projectAttention(snap);
  const ci = a.items.find((i) => i.id === "ci:failing");
  assert.ok(ci);
  assert.match(ci.detail, /windows/);
  assert.equal(ci.authority, "ci");
});

test("tasks waiting on a human, and tasks that stopped, are different rows", () => {
  const a = projectAttention(
    withReadiness({
      tasks: {
        counts: null,
        recent: [
          { id: "task_a", intent: "fix", lifecycle: "NEEDS_HUMAN", source: {} },
          {
            id: "task_b",
            intent: "fix",
            lifecycle: "STALLED",
            sessionId: "abcdefgh-1111",
            source: {},
          },
          { id: "task_c", intent: "fix", lifecycle: "RUNNING", source: {} },
        ],
      },
    }),
  );
  assert.equal(a.counts.attention, 1, "running work is not attention");
  assert.equal(a.counts.warning, 1);
  assert.ok(!a.items.some((i) => i.id === "task:task_c"));
});

test("a provider that stopped answering is itself actionable", () => {
  const a = projectAttention(
    withReadiness({
      reviewInbox: {
        ...base.reviewInbox,
        available: false,
        reason: "fetch-failed",
      },
    }),
  );
  assert.ok(a.items.some((i) => i.id === "provider:review-unavailable"));
});

test("advisory suggestions are structurally outside the authoritative list", () => {
  const suggested = projectSuggested([
    { id: "s1", title: "Claude thinks this thread is satisfied" },
  ]);
  assert.equal(suggested[0].authority, "claude-advisory");
  assert.equal(suggested[0].promotable, true);
  assert.ok(
    !("severity" in suggested[0]),
    "no severity: severity drives the badge, and advice does not",
  );

  // The projection takes no advisory input at all: there is no argument a
  // caller could pass that would put a suggestion into `items`.
  const a = projectAttention(withReadiness(), { suggested });
  assert.equal(a.counts.total, 0);
});

test("only a human promotion puts a suggestion in front of a person", () => {
  const dir = tmp();
  try {
    const record = promote(
      dir,
      {
        id: "rt_0123456789abcdef01234567",
        title: "Review thread on server/lib/git.mjs:20",
        origin: "assist:explain",
      },
      { now: Date.parse("2026-09-01T12:00:00Z") },
    );
    assert.equal(record.addedAt, "2026-09-01T12:00:00.000Z");

    const a = projectAttention(withReadiness(), {
      promotions: readPromotions(dir),
    });
    const item = a.items.find((i) => i.id.startsWith("promoted:"));
    assert.equal(item.authority, "human", "the record is the human's");
    assert.ok(
      item.evidence.some((e) => e.kind === "claude-advisory"),
      "the suggestion survives as provenance, not as authority",
    );

    assert.equal(dismiss(dir, "rt_0123456789abcdef01234567"), true);
    assert.equal(readPromotions(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a promotion cannot mint a blocking severity", () => {
  const dir = tmp();
  try {
    promote(dir, { id: "x1", title: "urgent", severity: "blocking" });
    const a = projectAttention(withReadiness(), {
      promotions: readPromotions(dir),
    });
    assert.equal(a.counts.blocking, 0);
    assert.equal(a.counts.attention, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("promotion refuses input a person could not have meant", () => {
  const dir = tmp();
  try {
    assert.equal(promote(dir, { id: "", title: "x" }), null);
    assert.equal(promote(dir, { id: "ok", title: "" }), null);
    assert.equal(promote(dir, { id: "../escape", title: "x" }), null);
    assert.equal(readPromotions(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable store degrades to empty rather than throwing", () => {
  assert.deepEqual(readPromotions(join(tmpdir(), "clawdeck-nope-xyz")), []);
});
