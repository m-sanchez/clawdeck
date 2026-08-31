// @ts-check
/** Unit tests for the session state machine. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEvent,
  reconcile,
} from "../server/core/events/projection.mjs";

const ev = (event, ts, extra = {}) => ({
  v: 1,
  id: `${event}-${ts}`,
  ts,
  event,
  session_id: "s1",
  data: {},
  ...extra,
});
function run(events) {
  const m = new Map();
  for (const e of events) applyEvent(m, e);
  return m.get("s1");
}

test("start -> running; stop -> idle; prompt after idle -> running", () => {
  assert.equal(run([ev("session.start", 1)]).state, "running");
  assert.equal(run([ev("session.start", 1), ev("stop", 2)]).state, "idle");
  assert.equal(
    run([ev("session.start", 1), ev("stop", 2), ev("prompt.submit", 3)]).state,
    "running",
  );
});

test("session.end -> completed; stopfailure -> failed", () => {
  assert.equal(
    run([ev("session.start", 1), ev("session.end", 2)]).state,
    "completed",
  );
  assert.equal(run([ev("stopfailure", 5)]).state, "failed");
});

test("compaction transitions and subagent counting", () => {
  const s = run([
    ev("session.start", 1),
    ev("subagent.start", 2, { agent_type: "Explore" }),
    ev("subagent.start", 3),
    ev("compact.pre", 4),
  ]);
  assert.equal(s.state, "compacting");
  assert.equal(s.subagents, 2);
  const s2 = run([ev("compact.pre", 4), ev("compact.post", 5)]);
  assert.equal(s2.state, "running");
});

test("reconcile marks a silent running session stale, leaves closed ones", () => {
  const m = new Map();
  applyEvent(m, ev("session.start", 1000));
  reconcile(m, 1000 + 20 * 60 * 1000); // 20 min later, no events
  assert.equal(m.get("s1").state, "stale");

  const done = new Map();
  applyEvent(done, ev("session.start", 1000));
  applyEvent(done, ev("session.end", 2000));
  reconcile(done, 2000 + 20 * 60 * 1000);
  assert.equal(done.get("s1").state, "completed"); // not reverted to stale
});
