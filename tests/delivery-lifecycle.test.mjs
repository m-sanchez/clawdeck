// @ts-check
/** Unit tests for the delivery lifecycle deriver. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDelivery } from "../server/core/delivery/lifecycle.mjs";

const base = (over = {}) => ({
  checkout: { dirty: true, dirtyCount: 3, ahead: 1 },
  validation: { status: "none", checks: [] },
  reviews: { blockCount: 0, warnCount: 0 },
  readiness: { evidence: [] },
  forge: { configured: false },
  ...over,
});
const stage = (d, key) => d.stages.find((s) => s.key === key);

test("clean tree: nothing to deliver", () => {
  const d = deriveDelivery({
    checkout: { dirty: false, ahead: 0 },
    validation: { status: "none" },
    reviews: {},
    readiness: {},
    forge: { configured: false },
  });
  assert.equal(d.hasChanges, false);
  assert.match(d.nextAction, /clean/i);
});

test("changed but not validated -> next action is run validation", () => {
  const d = deriveDelivery(base());
  assert.equal(stage(d, "changed").state, "done");
  assert.equal(stage(d, "validated").state, "pending");
  assert.equal(d.nextAction, "Run validation.");
});

test("failing validation blocks and is a blocker", () => {
  const d = deriveDelivery(
    base({ validation: { status: "failed", checks: [{ status: "failed" }] } }),
  );
  assert.equal(stage(d, "validated").state, "blocked");
  assert.ok(d.blockers.includes("Validation is failing"));
  assert.match(d.nextAction, /failing validation/i);
});

test("blocking review findings block the reviewed stage", () => {
  const d = deriveDelivery(
    base({
      validation: { passed: true, checks: [] },
      reviews: { blockCount: 2 },
    }),
  );
  assert.equal(stage(d, "reviewed").state, "blocked");
  assert.match(d.nextAction, /Resolve 2 blocking/);
});

test("pre-mr done + forge unconfigured skips MR/CI", () => {
  const d = deriveDelivery(
    base({
      validation: { passed: true },
      reviews: { blockCount: 0 },
      readiness: {
        evidence: [{ label: "/pre-mr marker matches HEAD", ok: true }],
      },
    }),
  );
  assert.equal(stage(d, "premr").state, "done");
  assert.equal(stage(d, "mr").state, "skipped");
  assert.equal(stage(d, "ci").state, "skipped");
  assert.match(d.nextAction, /Configure a forge/);
});
