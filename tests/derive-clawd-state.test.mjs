// @ts-check
/** Unit tests for the pure Clawd derivation layer. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveClawdState,
  deriveClawdPresentation,
  CLAWD_STATES,
} from "../ui/shared/clawd-state.mjs";

test("deriveClawdState honours the documented precedence", () => {
  assert.equal(
    deriveClawdState({
      blocked: true,
      requiresInput: true,
      completed: true,
      phase: "implementing",
    }),
    "blocked",
  );
  assert.equal(
    deriveClawdState({
      requiresInput: true,
      completed: true,
      phase: "implementing",
    }),
    "attention",
  );
  assert.equal(
    deriveClawdState({ completed: true, phase: "implementing" }),
    "success",
  );
  assert.equal(deriveClawdState({ phase: "investigating" }), "reading");
  assert.equal(deriveClawdState({ phase: "planning" }), "thinking");
  assert.equal(deriveClawdState({ phase: "implementing" }), "coding");
  assert.equal(deriveClawdState({ phase: "validating" }), "inspecting");
  assert.equal(deriveClawdState({ phase: "reviewing" }), "reviewing");
  assert.equal(deriveClawdState({ phase: "waiting" }), "waiting");
  assert.equal(deriveClawdState({ hasActiveRun: true }), "idle");
  assert.equal(deriveClawdState({}), "sleeping");
});

test("every derived state is a valid contract state", () => {
  for (const phase of [
    "investigating",
    "planning",
    "implementing",
    "validating",
    "reviewing",
    "waiting",
    "idle",
  ]) {
    assert.ok(CLAWD_STATES.includes(deriveClawdState({ phase })));
  }
});

test("presentation: blocked run outranks everything and pins its message", () => {
  const snap = {
    runs: [
      {
        id: "r1",
        title: "Fix auth",
        status: "failed",
        blockedReason: "tsc error",
      },
    ],
    reviews: { blockCount: 3 },
    validation: { checks: [{ status: "failed" }] },
  };
  const p = deriveClawdPresentation(snap);
  assert.equal(p.state, "blocked");
  assert.equal(p.persistent, true);
  assert.equal(p.showBadge, true);
  assert.match(p.message, /tsc error/);
  assert.equal(p.source, "r1");
});

test("presentation: blocking review findings raise attention when no run is failing", () => {
  const p = deriveClawdPresentation({
    runs: [],
    reviews: { blockCount: 2 },
    validation: { checks: [] },
  });
  assert.equal(p.state, "attention");
  assert.match(p.message, /2 blocking/);
});

test("presentation: an active loop run maps phase implementing → coding", () => {
  const p = deriveClawdPresentation({
    runs: [
      {
        id: "r2",
        title: "Migrate",
        status: "running",
        phase: "implementing",
        iteration: 2,
        maxIterations: 8,
      },
    ],
  });
  assert.equal(p.state, "coding");
  assert.equal(p.patrol, false);
  assert.match(p.message, /Migrate/);
});

test("presentation: a stale running run reads as waiting", () => {
  const p = deriveClawdPresentation({
    runs: [
      {
        id: "r3",
        title: "Slow",
        status: "running",
        phase: "implementing",
        stale: true,
      },
    ],
  });
  assert.equal(p.state, "waiting");
});

test("presentation: completed run with nothing active celebrates briefly", () => {
  const p = deriveClawdPresentation({
    runs: [{ id: "r4", title: "Done", status: "passed" }],
  });
  assert.equal(p.state, "success");
  assert.equal(p.showBadge, true);
});

test("presentation: services up but no runs → idle patrol; nothing → sleeping", () => {
  const idle = deriveClawdPresentation({
    runs: [],
    worktrees: [{ services: [{ status: "running" }] }],
  });
  assert.equal(idle.state, "idle");
  assert.equal(idle.patrol, true);
  const sleeping = deriveClawdPresentation({ runs: [], worktrees: [] });
  assert.equal(sleeping.state, "sleeping");
});

test("presentation: a running job reflects the kind of work", () => {
  const review = deriveClawdPresentation({
    runs: [],
    jobs: [
      {
        id: "j1",
        key: "review-pack",
        label: "Build review pack",
        status: "running",
      },
    ],
  });
  assert.equal(review.state, "reviewing");
  const verify = deriveClawdPresentation({
    runs: [],
    jobs: [{ id: "j2", key: "wt-verify", label: "Verify", status: "running" }],
  });
  assert.equal(verify.state, "inspecting");
  const lint = deriveClawdPresentation({
    runs: [],
    jobs: [{ id: "j3", key: "fix-lint", label: "Fix lint", status: "running" }],
  });
  assert.equal(lint.state, "coding");
});

test("presentation: active Claude agents (no runs/jobs) read as thinking", () => {
  const p = deriveClawdPresentation({
    runs: [],
    jobs: [],
    sessions: { activeCount: 3, agents: [] },
  });
  assert.equal(p.state, "thinking");
  assert.match(p.message, /3 Claude agents working/);
});
