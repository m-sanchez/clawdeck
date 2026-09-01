// @ts-check
/**
 * Assisted task lifecycle. The claims worth pinning: a task waiting for a human
 * to press enter is not a stalled agent, a session is bound by an observed
 * marker rather than by timing, settling requires a captured result, and
 * "changed nothing" can be a correct ending.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIFECYCLE,
  OUTCOME,
  bindSession,
  isStalled,
  makeTask,
  transition,
} from "../server/core/tasks/model.mjs";
import {
  newMarker,
  newTaskId,
  packetPath,
  readPacket,
  readTasks,
  reconcileTasks,
  removePacket,
  sweepStalled,
  taskForMarker,
  upsertTask,
  writePacket,
  writeTasks,
} from "../server/core/tasks/store.mjs";

const NOW = Date.parse("2026-09-01T12:00:00Z");
const dirs = [];
let runtime = "";

beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), "clawdeck-tasks-"));
  dirs.push(runtime);
});
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const fresh = (over = {}) =>
  makeTask({
    id: "task_aaaaaaaaaaaa",
    source: { kind: "review", id: "rt_" + "a".repeat(24) },
    intent: "fix",
    worktree: null,
    marker: "clawdeck-task:task_aaaaaaaaaaaa:deadbeefdeadbeef",
    now: NOW,
    ...over,
  });

test("a new task waits in CREATED with no start time", () => {
  const t = fresh();
  assert.equal(t.lifecycle, LIFECYCLE.CREATED);
  assert.equal(t.startedAt, null);
  assert.equal(t.sessionId, null);
  assert.equal(t.reconciliation, "unknown");
});

test("CREATED does not stall: the human may still be reading the prompt", () => {
  const t = fresh();
  const anHourLater = NOW + 60 * 60 * 1000;
  assert.equal(
    isStalled(t, { now: anHourLater, startupMs: 60_000, idleMs: 60_000 }),
    false,
  );
});

test("only an observed marker binds a session, never proximity in time", () => {
  const t = fresh();
  const wrong = bindSession(t, {
    sessionId: "sess-1",
    marker: "clawdeck-task:task_aaaaaaaaaaaa:not-the-marker",
    now: NOW,
  });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /marker/);

  const none = bindSession(t, { sessionId: "sess-1", marker: null, now: NOW });
  assert.equal(none.ok, false);

  const bound = bindSession(t, {
    sessionId: "sess-1",
    marker: t.correlationMarker,
    now: NOW,
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.task.lifecycle, LIFECYCLE.STARTING);
  assert.equal(bound.task.sessionId, "sess-1");
  assert.equal(bound.task.reconciliation, "bound");
  assert.equal(typeof bound.task.startedAt, "string");
});

test("the stall window opens only once a task has started", () => {
  const started = bindSession(fresh(), {
    sessionId: "sess-1",
    marker: fresh().correlationMarker,
    now: NOW,
  }).task;
  assert.equal(
    isStalled(started, { now: NOW + 5000, startupMs: 60_000, idleMs: 60_000 }),
    false,
  );
  assert.equal(
    isStalled(started, {
      now: NOW + 90_000,
      startupMs: 60_000,
      idleMs: 60_000,
    }),
    true,
  );
});

test("NEEDS_HUMAN and STALLED are pauses, not endings", () => {
  let t = bindSession(fresh(), {
    sessionId: "s",
    marker: fresh().correlationMarker,
    now: NOW,
  }).task;
  t = transition(t, LIFECYCLE.RUNNING, { now: NOW + 1000 }).task;

  const paused = transition(t, LIFECYCLE.NEEDS_HUMAN, { now: NOW + 2000 });
  assert.equal(paused.ok, true);
  const resumed = transition(paused.task, LIFECYCLE.RUNNING, {
    now: NOW + 3000,
  });
  assert.equal(resumed.ok, true, "work can resume after a human answers");

  const stalled = transition(resumed.task, LIFECYCLE.STALLED, {
    now: NOW + 4000,
  });
  assert.equal(
    transition(stalled.task, LIFECYCLE.RUNNING, { now: NOW + 5000 }).ok,
    true,
  );
});

test("settling requires a captured outcome; idleness is not a result", () => {
  let t = bindSession(fresh(), {
    sessionId: "s",
    marker: fresh().correlationMarker,
    now: NOW,
  }).task;
  t = transition(t, LIFECYCLE.RUNNING, { now: NOW + 1000 }).task;

  const bare = transition(t, LIFECYCLE.SETTLED, { now: NOW + 2000 });
  assert.equal(bare.ok, false);
  assert.match(bare.error, /captured outcome/);

  const settled = transition(t, LIFECYCLE.SETTLED, {
    outcome: OUTCOME.CHANGED,
    evidence: { files: ["server/lib/auth.mjs"] },
    now: NOW + 2000,
  });
  assert.equal(settled.ok, true);
  assert.equal(settled.task.outcome, OUTCOME.CHANGED);
  assert.equal(typeof settled.task.endedAt, "string");
});

test("deciding the reviewer was wrong is a valid ending, not a failure", () => {
  let t = bindSession(fresh(), {
    sessionId: "s",
    marker: fresh().correlationMarker,
    now: NOW,
  }).task;
  t = transition(t, LIFECYCLE.RUNNING, { now: NOW + 1000 }).task;
  const settled = transition(t, LIFECYCLE.SETTLED, {
    outcome: OUTCOME.NO_CHANGE_RECOMMENDED,
    cause: "the review is not valid; evidence attached",
    now: NOW + 2000,
  });

  assert.equal(settled.ok, true);
  assert.equal(settled.task.lifecycle, LIFECYCLE.SETTLED);
  assert.notEqual(settled.task.lifecycle, LIFECYCLE.FAILED);
  assert.equal(
    settled.task.evidence.files.length,
    0,
    "no code changed, and that is fine",
  );
});

test("terminal states are terminal, and illegal moves are refused", () => {
  let t = bindSession(fresh(), {
    sessionId: "s",
    marker: fresh().correlationMarker,
    now: NOW,
  }).task;
  t = transition(t, LIFECYCLE.RUNNING, { now: NOW + 1 }).task;
  const done = transition(t, LIFECYCLE.SETTLED, {
    outcome: OUTCOME.CHANGED,
    now: NOW + 2,
  }).task;

  assert.equal(transition(done, LIFECYCLE.RUNNING, { now: NOW + 3 }).ok, false);
  assert.equal(
    transition(fresh(), LIFECYCLE.RUNNING, { now: NOW }).ok,
    false,
    "CREATED cannot jump to RUNNING",
  );
  assert.equal(
    transition(fresh(), LIFECYCLE.CANCELLED, { now: NOW }).ok,
    true,
    "a never-launched task can be cancelled",
  );
});

test("the sweep stalls started tasks and leaves CREATED alone", () => {
  const waiting = fresh({ id: "task_bbbbbbbbbbbb" });
  const started = bindSession(fresh(), {
    sessionId: "s",
    marker: fresh().correlationMarker,
    now: NOW,
  }).task;
  let store = upsertTask(upsertTask(readTasks(runtime), waiting), started);

  const swept = sweepStalled(store, {
    now: NOW + 60 * 60 * 1000,
    startupMs: 60_000,
    idleMs: 60_000,
  });
  assert.equal(swept.changed, true);
  assert.equal(
    swept.store.tasks.find((t) => t.id === waiting.id).lifecycle,
    LIFECYCLE.CREATED,
  );
  assert.equal(
    swept.store.tasks.find((t) => t.id === started.id).lifecycle,
    LIFECYCLE.STALLED,
  );
});

test("records and packets survive a restart, and unprovable links stay unknown", () => {
  const t = bindSession(fresh(), {
    sessionId: "sess-9",
    marker: fresh().correlationMarker,
    now: NOW,
  }).task;
  const store = upsertTask(readTasks(runtime), t);
  assert.equal(writeTasks(runtime, store), true);

  const written = writePacket(runtime, t.id, "# Task\nFix the review.\n");
  assert.equal(written.ok, true);
  assert.equal(written.path, packetPath(runtime, t.id));

  // Restart: read from disk, then reconcile against the sessions that exist.
  const reloaded = readTasks(runtime);
  assert.equal(reloaded.tasks.length, 1);
  assert.equal(readPacket(runtime, t.id).includes("Fix the review"), true);
  assert.equal(taskForMarker(reloaded, t.correlationMarker).id, t.id);

  const gone = reconcileTasks(reloaded, {
    liveSessionIds: new Set(),
    now: NOW,
  });
  assert.equal(gone.store.tasks[0].reconciliation, "unknown");
  assert.notEqual(
    gone.store.tasks[0].lifecycle,
    LIFECYCLE.FAILED,
    "a session we can no longer see is not a failed task",
  );

  const back = reconcileTasks(gone.store, {
    liveSessionIds: new Set(["sess-9"]),
    now: NOW,
  });
  assert.equal(back.store.tasks[0].reconciliation, "bound");

  removePacket(runtime, t.id);
  assert.equal(readPacket(runtime, t.id), null);
});

test("the packet is a file, and nothing forces its text into a record", () => {
  const t = fresh();
  writeTasks(runtime, upsertTask(readTasks(runtime), t));
  writePacket(runtime, t.id, "SENSITIVE REVIEW CONTEXT");
  const raw = readFileSync(join(runtime, "tasks", "tasks.json"), "utf8");
  assert.equal(
    raw.includes("SENSITIVE REVIEW CONTEXT"),
    false,
    "the brief lives in its own file, not in the task record",
  );
});

test("ids and markers are shaped for the route and unique per task", () => {
  const a = newTaskId();
  const b = newTaskId();
  assert.match(a, /^task_[0-9a-f]{12}$/);
  assert.notEqual(a, b);
  assert.match(newMarker(a), new RegExp(`^clawdeck-task:${a}:[0-9a-f]{16}$`));
  assert.equal(writePacket(runtime, "../escape", "x").ok, false);
});
