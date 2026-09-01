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

test("the CI stage follows the read for this commit, not the branch's last run", () => {
  const forge = {
    configured: true,
    mr: { iid: 3 },
    pipeline: { status: "success" },
  };

  // The branch's latest run succeeded, but it belongs to whatever commit
  // triggered it - with work unpushed, that is not this one.
  const stale = deriveDelivery(base({ forge }));
  assert.equal(stage(stale, "ci").state, "current");
  assert.match(stage(stale, "ci").detail, /latest branch run/);

  const failing = deriveDelivery(
    base({
      forge,
      ci: {
        available: true,
        ref: "abcdef1234",
        summary: {
          state: "failing",
          coverage: { complete: true },
          counts: { total: 2, passing: 1, failing: 1, pending: 0 },
        },
      },
    }),
  );
  assert.equal(stage(failing, "ci").state, "blocked");
  assert.match(stage(failing, "ci").detail, /abcdef1/);
  assert.ok(failing.blockers.some((b) => /CI is failing/.test(b)));

  const unknown = deriveDelivery(
    base({
      forge,
      ci: {
        available: true,
        summary: {
          state: "unknown",
          coverage: { complete: false, reason: "commit statuses could not be read" },
          counts: { total: 1, passing: 1, failing: 0, pending: 0 },
        },
      },
    }),
  );
  assert.equal(stage(unknown, "ci").state, "pending");
  assert.match(stage(unknown, "ci").detail, /commit statuses/);
});
