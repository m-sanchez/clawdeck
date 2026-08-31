// @ts-check
/**
 * Phase I: a delivery stage is complete only when evidence proves it occurred.
 * Reviewed requires a review to have actually run (reviews.status === "ok"),
 * not merely "has changes + zero known blockers"; Merged derives from real
 * GitLab MR state; Cleanup-eligible is never falsely done for an unsafe tree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDelivery } from "../server/core/delivery/lifecycle.mjs";

const base = (over = {}) => ({
  checkout: { dirty: true, dirtyCount: 3, ahead: 1 },
  validation: { passed: true, checks: [] },
  reviews: { status: "pending", blockCount: 0, warnCount: 0 },
  readiness: { evidence: [] },
  forge: { configured: false },
  ...over,
});
const stage = (d, key) => d.stages.find((s) => s.key === key);

// D1: changes + no review run -> Reviewed = pending
test("D1: changes with no review run leave Reviewed pending", () => {
  const d = deriveDelivery(
    base({ reviews: { status: "pending", blockCount: 0 } }),
  );
  assert.equal(stage(d, "reviewed").state, "pending");
  assert.match(stage(d, "reviewed").detail, /not run|no review/i);
});

// D2: review completed + zero blockers -> Reviewed = done
test("D2: a completed review with zero blockers is done", () => {
  const d = deriveDelivery(
    base({ reviews: { status: "ok", blockCount: 0, warnCount: 2 } }),
  );
  assert.equal(stage(d, "reviewed").state, "done");
});

// D3: review completed + blockers -> Reviewed = blocked
test("D3: a completed review with blockers is blocked", () => {
  const d = deriveDelivery(base({ reviews: { status: "ok", blockCount: 3 } }));
  assert.equal(stage(d, "reviewed").state, "blocked");
});

// D4: MR merged -> Merged = done
test("D4: a merged MR marks Merged done", () => {
  const d = deriveDelivery(
    base({
      checkout: { dirty: false, ahead: 0 },
      reviews: { status: "ok", blockCount: 0 },
      forge: {
        configured: true,
        merged: true,
        mr: { iid: 507, state: "merged", webUrl: "u" },
        pipeline: { status: "success" },
      },
    }),
  );
  assert.equal(stage(d, "merged").state, "done");
});

test("D4b: an open MR leaves Merged pending", () => {
  const d = deriveDelivery(
    base({
      reviews: { status: "ok", blockCount: 0 },
      forge: {
        configured: true,
        merged: false,
        mr: { iid: 507, state: "opened", webUrl: "u" },
      },
    }),
  );
  assert.equal(stage(d, "merged").state, "pending");
});

// D5: merged but unsafe tree -> Cleanup eligible is NOT falsely done
test("D5: cleanup is not eligible while the tree is dirty", () => {
  const dirtyMerged = deriveDelivery(
    base({
      checkout: { dirty: true, dirtyCount: 2, ahead: 0 },
      reviews: { status: "ok", blockCount: 0 },
      forge: {
        configured: true,
        merged: true,
        mr: { iid: 1, state: "merged" },
      },
    }),
  );
  const cleanup = stage(dirtyMerged, "cleanup");
  assert.ok(cleanup, "cleanup stage exists");
  assert.notEqual(
    cleanup.state,
    "done",
    "dirty tree must not be cleanup-eligible",
  );

  const cleanMerged = deriveDelivery(
    base({
      checkout: { dirty: false, dirtyCount: 0, ahead: 0 },
      reviews: { status: "ok", blockCount: 0 },
      forge: {
        configured: true,
        merged: true,
        mr: { iid: 1, state: "merged" },
      },
    }),
  );
  assert.equal(stage(cleanMerged, "cleanup").state, "done");
});

// OL-3: a historical merged MR + a newer OPEN MR must not read "Merged done"
test("OL-3: Merged is not done when the selected MR is open (branch reused)", () => {
  const d = deriveDelivery(
    base({
      checkout: { dirty: false, ahead: 1 },
      reviews: { status: "ok", blockCount: 0 },
      forge: {
        configured: true,
        merged: true, // a historical MR merged
        mr: { iid: 900, state: "opened", webUrl: "u" }, // but the selected MR is open
      },
    }),
  );
  assert.notEqual(
    stage(d, "merged").state,
    "done",
    "open selected MR must not read merged",
  );
});

// Round B: a reused branch whose SELECTED MR is CLOSED must not read Merged done
test("Round B: a closed selected MR (historical merge present) is not Merged done", () => {
  const d = deriveDelivery(
    base({
      checkout: { dirty: false, ahead: 1 },
      reviews: { status: "ok", blockCount: 0 },
      forge: {
        configured: true,
        merged: true, // a historical MR merged
        mr: { iid: 902, state: "closed", webUrl: "u" }, // selected MR closed w/o merge
      },
    }),
  );
  assert.notEqual(
    stage(d, "merged").state,
    "done",
    "closed selected MR must not read merged",
  );
  assert.equal(stage(d, "merged").state, "blocked");
});

// regression: the previous behaviour (no review evidence -> done) must be gone
test("regression: hasChanges alone no longer marks Reviewed done", () => {
  const d = deriveDelivery(
    base({ reviews: { status: "pending", blockCount: 0 } }),
  );
  assert.notEqual(stage(d, "reviewed").state, "done");
});
