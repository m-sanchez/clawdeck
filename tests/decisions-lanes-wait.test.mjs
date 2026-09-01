// @ts-check
/**
 * Decision Ledger, fix lanes, and human-wait telemetry.
 *
 * Three separate ways a panel can start lying, guarded together:
 * a decision the model minted, a lane partition based on a feeling rather than
 * an overlap, and a "waiting on you" number derived from idleness.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDecisions,
  recordDecision,
  summarizeDecisions,
} from "../server/core/decisions/store.mjs";
import { partitionLanes } from "../server/core/lanes/partition.mjs";
import { waitsFor, waitSummary } from "../server/core/tasks/wait.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "clawdeck-4b-"));

test("a decision records who decided, and a drafter is only provenance", () => {
  const dir = tmp();
  try {
    const rec = recordDecision(
      dir,
      "pr-42",
      {
        decision: "Declined the reviewer's suggestion",
        reason: "The proposed guard duplicates parse-time validation.",
        rejectedAlternatives: ["Add the runtime guard"],
        decidedBy: "human",
        draftedBy: "claude-advisory",
      },
      { now: Date.parse("2026-09-01T09:00:00Z") },
    );
    assert.equal(rec.decidedBy, "human");
    assert.equal(rec.draftedBy, "claude-advisory");
    assert.equal(readDecisions(dir, "pr-42").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no authority other than human or mechanical-policy can be recorded", () => {
  const dir = tmp();
  try {
    // Absent counts as unrecognised: the authority has to be stated.
    for (const decidedBy of ["claude", "claude-advisory", "model", "", null, undefined])
      assert.equal(
        recordDecision(dir, "pr-42", { decision: "x", decidedBy }),
        null,
        `${decidedBy} must not be able to mint a decision`,
      );
    assert.equal(readDecisions(dir, "pr-42").length, 0);

    const policy = recordDecision(dir, "pr-42", {
      decision: "Auto-closed: branch merged",
      decidedBy: "mechanical-policy",
    });
    assert.equal(policy.decidedBy, "mechanical-policy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ledger summary carries no reasons and an unreadable one is empty", () => {
  const dir = tmp();
  try {
    recordDecision(dir, "pr-7", {
      decision: "Accepted the flake",
      reason: "secret-ish rationale",
      decidedBy: "human",
    });
    const s = summarizeDecisions(dir, "pr-7");
    assert.equal(s.total, 1);
    assert.ok(!("reason" in s.recent[0]));
    assert.deepEqual(readDecisions(dir, "../../etc"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lanes separate only what mechanically cannot collide", () => {
  const r = partitionLanes([
    { id: "a", files: ["server/lib/git.mjs"] },
    { id: "b", files: ["ui/views/delivery.mjs"] },
    { id: "c", files: ["server/lib/git.mjs", "server/lib/http.mjs"] },
  ]);
  assert.equal(r.parallelism, 2);
  const withA = r.lanes.find((l) => l.items.includes("a"));
  assert.deepEqual(withA.items.sort(), ["a", "c"]);
  assert.ok(
    withA.reasons.some((x) => /same file: server\/lib\/git\.mjs/.test(x)),
    "the overlap that grouped them is shown, not just the grouping",
  );
});

test("a shared worktree or test is a collision even with different files", () => {
  const wt = partitionLanes([
    { id: "a", files: ["x.mjs"], worktree: "wt-1" },
    { id: "b", files: ["y.mjs"], worktree: "wt-1" },
  ]);
  assert.equal(wt.parallelism, 1);

  const tests = partitionLanes([
    { id: "a", files: ["x.mjs"], tests: ["tests/api.test.mjs"] },
    { id: "b", files: ["y.mjs"], tests: ["tests/api.test.mjs"] },
  ]);
  assert.equal(tests.parallelism, 1);
});

test("an item with no file evidence is never guessed into a lane", () => {
  const r = partitionLanes([
    { id: "known", files: ["a.mjs"] },
    { id: "blind" },
  ]);
  assert.deepEqual(r.unpartitionable, ["blind"]);
  assert.deepEqual(r.lanes[0].items, ["known"]);
});

test("waits come from recorded transitions, and an open wait stays open", () => {
  const task = {
    id: "task_1",
    transitions: [
      { to: "CREATED", at: "2026-09-01T09:00:00Z" },
      { to: "STARTING", at: "2026-09-01T09:10:00Z" },
      { to: "RUNNING", at: "2026-09-01T09:11:00Z" },
      { to: "NEEDS_HUMAN", at: "2026-09-01T09:30:00Z" },
    ],
  };
  const w = waitsFor(task, { now: Date.parse("2026-09-01T10:00:00Z") });
  assert.equal(w.spans.length, 2);
  assert.equal(w.closedMs, 600000, "ten minutes before launch");
  assert.equal(w.openMs, 1800000, "thirty minutes and still waiting");
  assert.equal(w.hasOpenWait, true);
  assert.equal(w.spans[1].endedAt, null);
});

test("running time is not wait time", () => {
  const w = waitsFor({
    transitions: [
      { to: "STARTING", at: "2026-09-01T09:00:00Z" },
      { to: "RUNNING", at: "2026-09-01T09:01:00Z" },
      { to: "SETTLED", at: "2026-09-01T11:00:00Z" },
    ],
  });
  assert.equal(w.spans.length, 0);
  assert.equal(w.closedMs, 0);
});

test("no recorded waits reports no evidence, not zero waiting", () => {
  const s = waitSummary([{ id: "a", transitions: [] }]);
  assert.equal(s.measured, false);
  assert.equal(s.medianWaitMs, null);
});

test("the fleet number is a median, so one abandoned task cannot set it", () => {
  const mk = (id, mins) => ({
    id,
    transitions: [
      { to: "CREATED", at: "2026-09-01T09:00:00Z" },
      {
        to: "STARTING",
        at: new Date(
          Date.parse("2026-09-01T09:00:00Z") + mins * 60000,
        ).toISOString(),
      },
    ],
  });
  const s = waitSummary([mk("a", 2), mk("b", 4), mk("c", 6000)]);
  assert.equal(s.medianWaitMs, 240000, "four minutes, not the weekend one");
  assert.equal(s.longest.ms, 6000 * 60000);
  assert.equal(s.measured, true);
});
