// @ts-check
/**
 * The task projection carried in the snapshot: counts and identities, never the
 * brief or the evidence paths. It also has to make the one thing the panel
 * knows it is missing visible - a task that started but whose session link
 * cannot be proven.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIFECYCLE, OUTCOME } from "../server/core/tasks/model.mjs";
import {
  summarizeTasks,
  tasksForSource,
} from "../server/core/tasks/summary.mjs";

const task = (over = {}) => ({
  id: "task_aaaaaaaaaaaa",
  source: { kind: "review", id: "rt_" + "a".repeat(24) },
  intent: "fix",
  lifecycle: LIFECYCLE.CREATED,
  outcome: null,
  sessionId: null,
  startedAt: null,
  reconciliation: "unknown",
  createdAt: "2026-09-01T10:00:00Z",
  evidence: { files: [], commit: null, tests: [] },
  ...over,
});

test("counts separate awaiting-launch from actually running", () => {
  const { counts } = summarizeTasks({
    tasks: [
      task({ id: "task_a" }),
      task({
        id: "task_b",
        lifecycle: LIFECYCLE.RUNNING,
        startedAt: "x",
        sessionId: "s",
        reconciliation: "bound",
      }),
      task({
        id: "task_c",
        lifecycle: LIFECYCLE.STALLED,
        startedAt: "x",
        sessionId: "s",
        reconciliation: "bound",
      }),
      task({
        id: "task_d",
        lifecycle: LIFECYCLE.SETTLED,
        outcome: OUTCOME.CHANGED,
      }),
    ],
  });

  assert.equal(counts.total, 4);
  assert.equal(
    counts.awaitingLaunch,
    1,
    "a prompt nobody submitted is not running",
  );
  assert.equal(counts.running, 1);
  assert.equal(counts.stalled, 1);
  assert.equal(counts.settled, 1);
  assert.equal(counts.open, 3, "settled is the only closed one");
});

test("a started task with an unprovable session link is surfaced", () => {
  const { counts } = summarizeTasks({
    tasks: [
      task({
        lifecycle: LIFECYCLE.RUNNING,
        startedAt: "x",
        sessionId: "s",
        reconciliation: "unknown",
      }),
      task({
        id: "task_b",
        lifecycle: LIFECYCLE.RUNNING,
        startedAt: "x",
        sessionId: "s",
        reconciliation: "bound",
      }),
      // Never launched: not an unbound session, just not started.
      task({ id: "task_c" }),
    ],
  });
  assert.equal(counts.unboundSessions, 1);
});

test("the projection carries identities, never the work itself", () => {
  const { recent } = summarizeTasks({
    tasks: [
      task({
        lifecycle: LIFECYCLE.SETTLED,
        outcome: OUTCOME.CHANGED,
        sessionId: "sess-1",
        evidence: {
          files: ["server/lib/auth.mjs", "tests/auth.test.mjs"],
          commit: {
            sha: "8bd91f2abc",
            at: "2026-09-01T11:00:00Z",
            files: ["server/lib/auth.mjs"],
          },
          tests: [{ id: "unit", status: "passed" }],
        },
      }),
    ],
  });

  const row = recent[0];
  assert.equal(row.fileCount, 2, "a count, not the paths");
  assert.equal(row.commit, "8bd91f2abc");
  assert.equal(row.outcome, OUTCOME.CHANGED);
  const json = JSON.stringify(recent);
  assert.equal(
    json.includes("server/lib/auth.mjs"),
    false,
    "no paths in the snapshot",
  );
  assert.equal(json.includes("packetPath"), false);
  assert.ok(json.length < 900, "the projection stays small");
});

test("recent is newest first and bounded", () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    task({
      id: `task_${i}`,
      createdAt: `2026-09-01T10:${String(i).padStart(2, "0")}:00Z`,
    }),
  );
  const { recent } = summarizeTasks({ tasks: many });
  assert.equal(recent.length, 8);
  assert.equal(recent[0].createdAt, "2026-09-01T10:19:00Z");
});

test("tasks can be traced back to the blocker that caused them", () => {
  const threadId = "rt_" + "b".repeat(24);
  const store = {
    tasks: [
      task({ id: "task_a" }),
      task({ id: "task_b", source: { kind: "review", id: threadId } }),
      task({ id: "task_c", source: { kind: "ci", id: "check-9" } }),
    ],
  };
  assert.deepEqual(
    tasksForSource(store, "review", threadId).map((t) => t.id),
    ["task_b"],
  );
  assert.equal(tasksForSource(store, "ci", "check-9").length, 1);
  assert.equal(tasksForSource(store, "review", "nope").length, 0);
});

test("an empty store summarizes without inventing anything", () => {
  const s = summarizeTasks({ tasks: [] });
  assert.equal(s.counts.total, 0);
  assert.deepEqual(s.recent, []);
});
