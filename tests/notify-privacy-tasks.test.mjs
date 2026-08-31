// @ts-check
/**
 * Phase M (notification privacy) + Phase K (task events).
 * M: arbitrary notification text is NOT persisted — only metadata
 *    {notificationType, hasMessage, messageLength}.
 * K: task.created / task.completed are projected into per-session counters
 *    (session -> task correlation), not silently dropped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import normalize from "../hooks/lib/event-normalize.cjs";
import { applyEvent } from "../server/core/events/projection.mjs";

const { normalizeEvent } = normalize;

// ── M: notification redaction ──

test("M: Notification stores metadata only, never the message text", () => {
  const e = normalizeEvent(
    {
      hook_event_name: "Notification",
      session_id: "s1",
      message: "SECRET approval link https://internal/x?token=abc",
      notification_type: "permission",
    },
    { id: "n1", ts: 1 },
  );
  const json = JSON.stringify(e);
  assert.ok(!json.includes("SECRET"));
  assert.ok(!json.includes("token=abc"));
  assert.equal(e.data.hasMessage, true);
  assert.equal(typeof e.data.messageLength, "number");
  assert.equal(e.data.notificationType, "permission");
  assert.equal(e.data.message, undefined, "no raw message field");
});

test("M: projection notify attention is a generic label, not the text", () => {
  const sessions = new Map();
  applyEvent(sessions, {
    v: 1,
    id: "n1",
    ts: 10,
    event: "notify",
    session_id: "s1",
    data: {
      notificationType: "permission",
      hasMessage: true,
      messageLength: 40,
    },
  });
  const att = sessions.get("s1").attention;
  assert.ok(/permission|notification/i.test(att));
  assert.ok(!/SECRET|token/i.test(att));
});

// ── K: task events projected ──

test("K: task.created / task.completed update per-session counters", () => {
  const sessions = new Map();
  const ev = (id, event, ts, data = {}) => ({
    v: 1,
    id,
    ts,
    event,
    session_id: "s1",
    data,
  });
  applyEvent(sessions, ev("t1", "task.created", 100, { status: "pending" }));
  applyEvent(sessions, ev("t2", "task.created", 110, { status: "pending" }));
  applyEvent(
    sessions,
    ev("t3", "task.completed", 200, { status: "completed" }),
  );
  const s = sessions.get("s1");
  assert.equal(s.tasksCreated, 2);
  assert.equal(s.tasksCompleted, 1);
});

test("K: task events are counted but do not change the running/idle state", () => {
  const sessions = new Map();
  applyEvent(sessions, {
    v: 1,
    id: "st",
    ts: 100,
    event: "stop",
    session_id: "s1",
    data: {},
  });
  applyEvent(sessions, {
    v: 1,
    id: "t1",
    ts: 150,
    event: "task.completed",
    session_id: "s1",
    data: { status: "completed" },
  });
  // A task event is not a liveness signal; the session stays idle.
  assert.equal(sessions.get("s1").state, "idle");
  assert.equal(sessions.get("s1").tasksCompleted, 1);
});
