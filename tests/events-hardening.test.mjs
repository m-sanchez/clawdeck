// @ts-check
/**
 * Round-1 event-spine hardening (Auditor C). Regression tests for:
 *  - future-ts state pin (a far-future event freezing projection forever)
 *  - subagent agent_id reuse across distinct agents
 *  - writer-lock pid-reuse lockout + owner-only release
 *  - empty commondir resolving to the wrong shared root
 *  - PostToolUse tool_response.success object leak (redaction)
 *  - store.rotate wiring / offset-key consistency
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { EventStore } from "../server/core/events/store.mjs";
import {
  applyEvent,
  reconcile,
} from "../server/core/events/projection.mjs";
import { validateEvent } from "../server/core/events/schema.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT = path.resolve(here, "..");
const require_ = createRequire(import.meta.url);
const spool = require_(
  path.join(CHECKOUT, "hooks", "lib", "event-spool.cjs"),
);
const normalize = require_(
  path.join(CHECKOUT, "hooks", "lib", "event-normalize.cjs"),
);

const ev = (id, event, ts, extra = {}) => ({
  v: 1,
  id,
  ts,
  event,
  session_id: "s1",
  cwd: "/repo",
  data: {},
  ...extra,
});
function eventsDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "evh-")), "events");
}

// ── C#1 (HIGH): a far-future ts must not permanently pin projected state ──

test("future-ts event does not freeze a running session", () => {
  const sessions = new Map();
  const future = 4102444800000; // year 2100
  applyEvent(sessions, ev("boom", "stop", future));
  applyEvent(sessions, ev("s", "session.start", 1000));
  applyEvent(sessions, ev("p", "prompt.submit", 2000));
  applyEvent(sessions, ev("t", "tool.pre", 3000, { data: { tool: "Edit" } }));
  const s = sessions.get("s1");
  assert.equal(s.state, "running", "real events after a future stop must win");
});

test("validateEvent rejects a wildly future ts at the trust boundary", () => {
  const now = 1_000_000_000_000;
  assert.equal(validateEvent(ev("ok", "stop", now), { now }), null);
  assert.ok(
    validateEvent(ev("bad", "stop", now + 10 * 86400000), { now }),
    "a ts > now + skew is rejected",
  );
});

// ── C#6: subagent agent_id reuse across distinct agents ──

test("an agent_id reused by a genuinely newer agent is counted, not tombstoned", () => {
  const sessions = new Map();
  applyEvent(sessions, ev("a", "subagent.start", 100, { agent_id: "ag1" }));
  applyEvent(sessions, ev("b", "subagent.stop", 200, { agent_id: "ag1" }));
  // A NEW agent reuses the id, strictly after the recorded stop.
  applyEvent(sessions, ev("c", "subagent.start", 300, { agent_id: "ag1" }));
  assert.equal(sessions.get("s1").subagents, 1, "newer reuse is active");
  // The classic reorder case still holds: a start OLDER than the stop is dropped.
  const s2 = new Map();
  applyEvent(s2, ev("x", "subagent.stop", 200, { agent_id: "ag2" }));
  applyEvent(s2, ev("y", "subagent.start", 150, { agent_id: "ag2" }));
  assert.equal(
    s2.get("s1").subagents,
    0,
    "older-than-stop start stays dropped",
  );
});

// ── C#3: PostToolUse success redaction ──

test("PostToolUse redaction coerces success to a boolean (no object leak)", () => {
  const out = normalize.normalizeEvent(
    {
      hook_event_name: "PostToolUse",
      session_id: "s1",
      tool_name: "mcp__x__do",
      tool_response: { success: { secretPath: "/etc/shadow", rows: [1, 2] } },
    },
    { id: "e1", ts: 1 },
  );
  assert.equal(typeof out.data.ok, "boolean");
  assert.ok(!JSON.stringify(out).includes("/etc/shadow"));
});

// ── C#4: empty commondir must not resolve to <main>/.git/worktrees ──

test("empty commondir falls through to the correct main root", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cd-"));
  const main = path.join(tmp, "main");
  fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
  const wt = path.join(tmp, "wt");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(
    path.join(main, ".git", "worktrees", "wt", "commondir"),
    "\n", // empty/whitespace-only
  );
  fs.writeFileSync(
    path.join(wt, ".git"),
    `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`,
  );
  assert.equal(spool.sharedRuntimeRoot(wt), main);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Round-D: a self-referential commondir ('.') falls through, not into .git", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cd-"));
  const main = path.join(tmp, "main");
  fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
  const wt = path.join(tmp, "wt");
  fs.mkdirSync(wt, { recursive: true });
  // A commondir that resolves back into the worktree's own gitdir would split
  // events under .git/worktrees/... rather than the main checkout.
  fs.writeFileSync(
    path.join(main, ".git", "worktrees", "wt", "commondir"),
    ".\n",
  );
  fs.writeFileSync(
    path.join(wt, ".git"),
    `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`,
  );
  assert.equal(spool.sharedRuntimeRoot(wt), main);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Round-D: a terminated/stale session reports zero active subagents", () => {
  // Asymmetric pair: start carries an agent_id, the stop does not. During the
  // run the count may over-report (conservative); once the session ends it MUST
  // be zero — no phantom subagent leaks into a finished session.
  for (const terminal of [
    { event: "stop", ts: 200 },
    { event: "session.end", ts: 200 },
    { event: "stopfailure", ts: 200 },
  ]) {
    const sessions = new Map();
    const sid = `asym-${terminal.event}`;
    applyEvent(sessions, { session_id: sid, event: "session.start", ts: 100 });
    applyEvent(sessions, {
      session_id: sid,
      event: "subagent.start",
      ts: 110,
      agent_id: "A",
    });
    applyEvent(sessions, { session_id: sid, event: "subagent.stop", ts: 120 }); // no id
    applyEvent(sessions, { session_id: sid, ...terminal });
    assert.equal(
      sessions.get(sid).subagents,
      0,
      `${terminal.event} must leak no phantom subagent`,
    );
  }
  // A stale (crashed mid-run) session also reports zero.
  const s = new Map();
  applyEvent(
    s,
    { session_id: "st", event: "subagent.start", ts: 10, agent_id: "Y" },
    10,
  );
  reconcile(s, 10 + 20 * 60 * 1000);
  assert.equal(s.get("st").state, "stale");
  assert.equal(s.get("st").subagents, 0);
});

// ── Round-A E1: tombstone eviction must not resurrect a stopped subagent ──

test("an evicted tombstone does not resurrect an already-stopped subagent", () => {
  const sessions = new Map();
  const push = (id, event, ts, agent_id) =>
    applyEvent(sessions, ev(id, event, ts, { agent_id }));
  // ag0 starts and stops early.
  push("s0", "subagent.start", 100, "ag0");
  push("e0", "subagent.stop", 200, "ag0");
  // 250 more distinct agents start+stop, overflowing the 200 tombstone cap and
  // evicting ag0's tombstone.
  for (let i = 1; i <= 250; i++) {
    push(`s${i}`, "subagent.start", 300 + i, `ag${i}`);
    push(`x${i}`, "subagent.stop", 300 + i + 0.5, `ag${i}`);
  }
  // A late/duplicate start for ag0 at ts=1 (OLDER than its stop@200) must stay
  // suppressed even though its tombstone was evicted.
  push("late", "subagent.start", 1, "ag0");
  assert.equal(
    sessions.get("s1").subagents,
    0,
    "evicted-but-older start resurrected the agent",
  );
});

test("a genuinely newer id reuse is still admitted after eviction", () => {
  const sessions = new Map();
  const push = (id, event, ts, agent_id) =>
    applyEvent(sessions, ev(id, event, ts, { agent_id }));
  push("s0", "subagent.start", 100, "ag0");
  push("e0", "subagent.stop", 200, "ag0");
  for (let i = 1; i <= 250; i++) {
    push(`s${i}`, "subagent.start", 300 + i, `ag${i}`);
    push(`x${i}`, "subagent.stop", 300 + i + 0.5, `ag${i}`);
  }
  // A NEW agent reusing ag0 with a start strictly newer than everything → active.
  push("new", "subagent.start", 100000, "ag0");
  assert.equal(sessions.get("s1").subagents, 1);
});

// ── Round-A E4: startedAt is order-independent ──

test("startedAt reflects the earliest event even under reordered delivery", () => {
  const sessions = new Map();
  applyEvent(sessions, ev("t", "tool.pre", 3000, { data: { tool: "Read" } }));
  applyEvent(sessions, ev("s", "session.start", 1000));
  assert.equal(
    sessions.get("s1").startedAt,
    1000,
    "late session.start must win the min",
  );
});

// ── Round-A E3: rotate prunes in-memory seen/sessions, not just disk ──

test("rotate prunes seen ids + stale sessions so memory does not grow forever", () => {
  const dir = eventsDir();
  const store = new EventStore(dir);
  const DAY = 86400000;
  // An old session, fully in a store day-file that rotation will remove.
  store.ingest(ev("old1", "session.start", 1 * DAY, { session_id: "old" }));
  store.ingest(ev("old2", "stop", 1 * DAY + 5, { session_id: "old" }));
  // A recent session that survives.
  const now = 100 * DAY;
  store.ingest(ev("new1", "session.start", now, { session_id: "fresh" }));
  assert.ok(store.seen.has("old1"));
  store.rotate(14, now);
  assert.ok(
    !store.seen.has("old1"),
    "seen id from a rotated day-file must be pruned",
  );
  assert.ok(store.seen.has("new1"), "surviving id retained");
  const ids = store.snapshot().sessions.map((s) => s.sessionId);
  assert.ok(!ids.includes("old"), "stale session evicted from the projection");
  assert.ok(ids.includes("fresh"), "recent session retained");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Round-C C1: a far-future FIRST event must not pin lastEventAt (freeze) ──

test("far-future first event: startedAt + lastEventAt use the clamped value", async () => {
  const proj = await import("../server/core/events/projection.mjs");
  const now = 1_000_000_000_000;
  const sessions = new Map();
  proj.applyEvent(sessions, ev("f", "session.start", now + 3_600_000), now);
  const s = sessions.get("s1");
  assert.ok(s.lastEventAt <= now, "lastEventAt clamped");
  assert.ok(s.startedAt <= now, "startedAt clamped");
  // Now silent past the window → reconcile marks it stale (not frozen).
  proj.reconcile(sessions, now + proj.STALE_MS + 60000);
  assert.equal(sessions.get("s1").state, "stale");
});

// ── Round-C C3: two DIFFERENT terminal states at equal ts are deterministic ──

test("equal-ts stop vs stopfailure resolves deterministically (failed wins) either order", () => {
  const a = new Map();
  applyEvent(a, ev("st", "stop", 1000));
  applyEvent(a, ev("sf", "stopfailure", 1000));
  const b = new Map();
  applyEvent(b, ev("sf", "stopfailure", 1000));
  applyEvent(b, ev("st", "stop", 1000));
  assert.equal(
    a.get("s1").state,
    b.get("s1").state,
    "terminal tie must be order-independent",
  );
  assert.equal(
    a.get("s1").state,
    "failed",
    "failed outranks idle at an equal-ts tie",
  );
});

// ── Round-B EVT-B2: equal-ts state tie is deterministic (terminal wins) ──

test("an equal-ts stop vs tool.post tie resolves to the terminal state either order", () => {
  const a = new Map();
  applyEvent(a, ev("tp", "tool.post", 1000, { data: { tool: "Edit" } }));
  applyEvent(a, ev("st", "stop", 1000));
  assert.equal(a.get("s1").state, "idle", "tool.post then stop");
  const b = new Map();
  applyEvent(b, ev("st", "stop", 1000));
  applyEvent(b, ev("tp", "tool.post", 1000, { data: { tool: "Edit" } }));
  assert.equal(
    b.get("s1").state,
    "idle",
    "stop then tool.post — terminal still wins",
  );
});

test("a genuinely newer non-terminal event after stop still revives (no over-suppression)", () => {
  const m = new Map();
  applyEvent(m, ev("st", "stop", 1000));
  applyEvent(m, ev("p", "prompt.submit", 1001));
  assert.equal(m.get("s1").state, "running");
});

// ── Round-B EVT-B1: legacy-offset must not resurrect rotated events ──

test("rotate does not clear a legacy offset when a same-named shared file rotates", () => {
  const dir = eventsDir();
  const store = new EventStore(dir);
  const DAY = 86400000;
  // An old file in the SHARED spool that rotation will delete...
  const sd = path.join(dir, "spool");
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, "2020-01-01.ndjson"), "");
  // ...and a legacy-spool offset (a DIFFERENT dir rotate does not manage) that
  // happens to share the day name. Rotating the shared file must not clear it,
  // or the legacy spool re-ingests from 0 on the next start.
  store.offsets["2020-01-01.ndjson"] = 10;
  store.offsets["legacy:2020-01-01.ndjson"] = 500;
  store.rotate(14, 100 * DAY);
  assert.equal(
    store.offsets["legacy:2020-01-01.ndjson"],
    500,
    "legacy offset must survive rotation of a same-named shared file",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── C#2: writer-lock pid-reuse + owner-only release ──

test("a stale-by-age lock is reclaimed even if an unrelated pid is alive", () => {
  const dir = eventsDir();
  fs.mkdirSync(dir, { recursive: true });
  // Simulate a crashed panel whose pid was reused by an unrelated live process.
  fs.writeFileSync(
    path.join(dir, ".writer.lock"),
    JSON.stringify({ pid: 4242, at: 1000, nonce: "old" }),
  );
  const now = 1000 + 10 * 60 * 1000; // well past the lock TTL
  const got = spool.acquireWriterLock(dir, 5555, {
    isAlive: () => true, // pid 4242 "alive" (reused)
    now: () => now,
  });
  assert.equal(got.ok, true, "age-stale lock reclaimed despite live pid");
});

test("Round-D: reclaim aborts when the stale lock is replaced under it (no double-own)", () => {
  const dir = eventsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ".writer.lock");
  // An age-stale lock owned by a dead pid.
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, at: 1000 }));
  const now = 1000 + 10 * 60 * 1000; // past TTL
  // In the reclaim window a racer (pid 222) fully acquires: it removes the stale
  // lock and installs its own fresh lock at the same path. The reclaimer must
  // notice the change and NOT clobber it into a double-own.
  let injected = false;
  const got = spool.acquireWriterLock(dir, 111, {
    isAlive: (p) => p === 222, // stale owner 999999 is dead; the racer is alive
    now: () => now,
    beforeReclaim: () => {
      if (injected) return;
      injected = true;
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, JSON.stringify({ pid: 222, at: now }));
    },
  });
  assert.equal(
    got.ok,
    false,
    "must not double-own after the lock was replaced",
  );
  assert.equal(got.ownerPid, 222);
  const owner = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(owner.pid, 222, "the racer remains the sole owner");
});

test("Round-F: a valid-JSON but non-lock-shape lock is reclaimed, never throws (isAlive injected → deterministic on every OS)", () => {
  // isAlive:()=>true removes the platform split (Linux pid 1 is alive; on Windows
  // pid 1 is absent). A malformed lock must be reclaimed on SHAPE alone, never
  // treated as a live owner just because its recorded pid happens to be alive and
  // a NaN `at` (Number("soon")||0 = 0) looks "fresh" under the injected clock.
  for (const bad of [
    "null",
    "123",
    "false",
    "[1,2,3]",
    "{}",
    '{"at":5}', // missing pid
    '{"pid":123}', // missing at
    '{"pid":1,"at":"soon"}', // non-numeric at (the reported bug)
    '{"pid":"x","at":5}', // non-numeric pid
  ]) {
    const dir = eventsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".writer.lock"), bad);
    let got;
    assert.doesNotThrow(() => {
      got = spool.acquireWriterLock(dir, 777, {
        isAlive: () => true,
        now: () => 5,
      });
    }, `must not throw: ${bad}`);
    assert.equal(
      got.ok,
      true,
      `malformed lock must be reclaimed on shape alone: ${bad}`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // isValidLock enforces the strict protocol domain: pid is a safe integer > 0,
  // at is a safe integer >= 0. Malformed numeric shapes must be rejected so they
  // can never impersonate a live owner.
  for (const ok of [
    { pid: 1, at: 2 },
    { pid: 1, at: 0 }, // at may be exactly 0
    { pid: 999999, at: 1720000000000, nonce: "x" }, // extra fields allowed
  ])
    assert.equal(spool.isValidLock(ok), true, `valid: ${JSON.stringify(ok)}`);
  for (const bad of [
    null,
    5,
    "x",
    [],
    {},
    { pid: 1 }, // missing at
    { at: 1 }, // missing pid
    { pid: 1, at: "soon" }, // non-numeric at
    { pid: 0, at: 1 }, // pid must be > 0
    { pid: -1, at: 1 }, // pid must be > 0
    { pid: 1.5, at: 1 }, // pid must be an integer
    { pid: 1, at: -1 }, // at must be >= 0
    { pid: 1, at: 1.5 }, // at must be an integer
    { pid: Infinity, at: 1 },
    { pid: 1, at: Infinity },
    { pid: NaN, at: 1 },
    { pid: 1, at: NaN },
  ])
    assert.equal(
      spool.isValidLock(bad),
      false,
      `invalid: ${JSON.stringify(bad)}`,
    );
});

test("Round-F: a SHAPE-VALID lock is still honored (the gate does not over-reclaim)", () => {
  const TTL = spool.LOCK_TTL_MS;
  // Valid + fresh + live owner -> refused (not reclaimed).
  const d1 = eventsDir();
  fs.mkdirSync(d1, { recursive: true });
  fs.writeFileSync(
    path.join(d1, ".writer.lock"),
    JSON.stringify({ pid: 4242, at: 1000 }),
  );
  const live = spool.acquireWriterLock(d1, 777, {
    isAlive: () => true,
    now: () => 1000 + 5,
  });
  assert.equal(live.ok, false, "a valid fresh live lock is honored");
  assert.equal(live.ownerPid, 4242);
  // Valid + age-stale -> reclaimed even with a live pid.
  const d2 = eventsDir();
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(
    path.join(d2, ".writer.lock"),
    JSON.stringify({ pid: 4242, at: 1000 }),
  );
  const stale = spool.acquireWriterLock(d2, 777, {
    isAlive: () => true,
    now: () => 1000 + TTL + 1,
  });
  assert.equal(stale.ok, true, "a valid age-stale lock is reclaimed");
  // Valid + self-owned -> refreshed (ok).
  const d3 = eventsDir();
  fs.mkdirSync(d3, { recursive: true });
  fs.writeFileSync(
    path.join(d3, ".writer.lock"),
    JSON.stringify({ pid: 777, at: 1000 }),
  );
  const self = spool.acquireWriterLock(d3, 777, {
    isAlive: () => true,
    now: () => 1000 + 5,
  });
  assert.equal(self.ok, true, "our own lock is refreshed, not refused");
});

test("Round-E: an unreadable/corrupt/0-byte lock is reclaimed, not permanently stuck", () => {
  for (const bad of ["not json{{{", ""]) {
    const dir = eventsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".writer.lock"), bad);
    const got = spool.acquireWriterLock(dir, 777, { now: () => 5 });
    assert.equal(
      got.ok,
      true,
      `corrupt/empty lock must be reclaimable: ${JSON.stringify(bad)}`,
    );
    // The reclaimed lock is now valid + owned; another pid is refused.
    const other = spool.acquireWriterLock(dir, 888, {
      isAlive: () => true,
      now: () => 6,
    });
    assert.equal(other.ok, false, "reclaimed lock is valid and owned");
  }
});

test("Round-J: the subagent count is order-independent past 400 distinct ids", () => {
  // 401 done agents + one always-active agent Z (start@1, never stopped). The
  // count must be 1 regardless of delivery order (no cap-prune order-dependence).
  const events = [{ event: "subagent.start", ts: 1, agent_id: "Z" }];
  for (let i = 0; i < 401; i++) {
    events.push({
      event: "subagent.start",
      ts: 100 + 2 * i,
      agent_id: `d${i}`,
    });
    events.push({ event: "subagent.stop", ts: 101 + 2 * i, agent_id: `d${i}` });
  }
  const count = (order) => {
    const m = new Map();
    for (const e of order) applyEvent(m, { session_id: "s", ...e });
    return m.get("s").subagents;
  };
  // ts order (Z first) and Z delivered LAST (after the prune would have fired).
  assert.equal(count(events), 1, "Z active in ts order");
  const zLast = [...events.slice(1), events[0]];
  assert.equal(count(zLast), 1, "Z still active when delivered last");
});

test("Round-I: the ANON subagent count is order-independent across a terminal", () => {
  // anon start@100, session stop@150 (terminal), anon start@200. Only the
  // post-terminal start counts (1), regardless of delivery order.
  const evs = [
    { event: "subagent.start", ts: 100 },
    { event: "stop", ts: 150 },
    { event: "subagent.start", ts: 200 },
  ];
  const perms = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const p of perms) {
    const m = new Map();
    for (const i of p) applyEvent(m, { session_id: "s", ...evs[i] });
    assert.equal(
      m.get("s").subagents,
      1,
      `anon count order-dependent for ${p}`,
    );
  }
});

test("Round-H: a terminal delivered LATE (behind a newer event) still bounds the count", () => {
  const evs = [
    { event: "tool.pre", ts: 300, data: { tool: "Edit" } },
    { event: "stopfailure", ts: 150 },
    { event: "subagent.start", ts: 100, agent_id: "ag1" },
  ];
  const perms = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const p of perms) {
    const m = new Map();
    for (const i of p) applyEvent(m, { session_id: "s", ...evs[i] });
    // start@100 predates the terminal@150 -> phantom must not count, any order.
    assert.equal(m.get("s").subagents, 0, `order ${p} leaves a phantom`);
    assert.equal(m.get("s").state, "running", `order ${p} wrong state`);
  }
});

test("Round-H: an equal-ms tie between two non-terminal states is deterministic", () => {
  const run = (order) => {
    const m = new Map();
    for (const e of order) applyEvent(m, { session_id: "s", ...e });
    return m.get("s").state;
  };
  const base = { event: "subagent.start", ts: 1, agent_id: "B" };
  const a = run([
    base,
    { event: "subagent.start", ts: 3 },
    { event: "compact.pre", ts: 3 },
  ]);
  const b = run([
    base,
    { event: "compact.pre", ts: 3 },
    { event: "subagent.start", ts: 3 },
  ]);
  assert.equal(a, b, "running/compacting tie must be order-independent");
});

test("Round-G: a reused-id triple counts order-independently (start watermark)", () => {
  // instance-1 [start@150, stop@160], instance-2 [start@200, still running].
  // The same three events in either delivery order must yield subagents === 1.
  const evs = [
    { event: "subagent.start", ts: 150, agent_id: "X" },
    { event: "subagent.stop", ts: 160, agent_id: "X" },
    { event: "subagent.start", ts: 200, agent_id: "X" },
  ];
  for (const order of [evs, [evs[2], evs[0], evs[1]]]) {
    const m = new Map();
    for (const e of order) applyEvent(m, { session_id: "s", ...e });
    assert.equal(
      m.get("s").subagents,
      1,
      `reused-id count must be 1 for order ${JSON.stringify(order.map((e) => e.ts))}`,
    );
  }
});

test("Round-F: subagent count is order-independent for reused ids + revived sessions", () => {
  // A late OLDER stop must not clear a newer reused-id agent.
  const a = new Map();
  applyEvent(a, {
    session_id: "s",
    event: "subagent.start",
    ts: 300,
    agent_id: "ag1",
  });
  applyEvent(a, {
    session_id: "s",
    event: "subagent.stop",
    ts: 200,
    agent_id: "ag1",
  });
  assert.equal(
    a.get("s").subagents,
    1,
    "a late old stop must not clear a newer reused-id agent",
  );
  // A pre-terminal start applied AFTER a revival must not resurrect a phantom.
  const b = new Map();
  applyEvent(b, { session_id: "s", event: "stopfailure", ts: 150 });
  applyEvent(b, {
    session_id: "s",
    event: "tool.pre",
    ts: 300,
    data: { tool: "Edit" },
  });
  applyEvent(b, {
    session_id: "s",
    event: "subagent.start",
    ts: 100,
    agent_id: "ag1",
  });
  assert.equal(b.get("s").state, "running", "the newer tool event revives it");
  assert.equal(
    b.get("s").subagents,
    0,
    "a start older than the terminal is not resurrected",
  );
});

test("Round-E: a late subagent.start after a terminal state revives no phantom count", () => {
  const sessions = new Map();
  const sid = "late";
  applyEvent(sessions, { session_id: sid, event: "session.start", ts: 100 });
  applyEvent(sessions, { session_id: sid, event: "stop", ts: 200 });
  // A late (older-ts) subagent.start promoted from the spool AFTER the stop.
  applyEvent(sessions, {
    session_id: sid,
    event: "subagent.start",
    ts: 150,
    agent_id: "G",
  });
  const s = sessions.get(sid);
  assert.equal(s.state, "idle", "older event does not revive the session");
  assert.equal(
    s.subagents,
    0,
    "a terminated session reports no active subagents",
  );
  // A NEWER subagent.start legitimately resumes the session and counts.
  applyEvent(sessions, {
    session_id: sid,
    event: "subagent.start",
    ts: 300,
    agent_id: "H",
  });
  assert.equal(sessions.get(sid).state, "running");
  assert.equal(sessions.get(sid).subagents, 1);
});

test("Round-D: touchWriterLock returns false once reclaimed (panel demotion signal)", () => {
  const dir = eventsDir();
  fs.mkdirSync(dir, { recursive: true });
  // Panel A owns the lock.
  assert.equal(spool.acquireWriterLock(dir, 111, { now: () => 1 }).ok, true);
  // A's heartbeat lapses; panel B reclaims the age-stale lock.
  const later = 1 + 10 * 60 * 1000;
  assert.equal(
    spool.acquireWriterLock(dir, 222, {
      isAlive: () => false,
      now: () => later,
    }).ok,
    true,
  );
  // A's next heartbeat reports it no longer holds the lock -> the panel demotes.
  assert.equal(spool.touchWriterLock(dir, 111, later), false);
  assert.equal(spool.touchWriterLock(dir, 222, later), true);
});

test("Round-C: the lock is published atomically (never observable at 0 bytes)", () => {
  const dir = eventsDir();
  fs.mkdirSync(dir, { recursive: true });
  const got = spool.acquireWriterLock(dir, 111, { now: () => 5 });
  assert.equal(got.ok, true);
  const lockPath = path.join(dir, ".writer.lock");
  // The lock is fully written the instant it exists — never a 0-byte window.
  const body = fs.readFileSync(lockPath, "utf8");
  assert.ok(body.length > 0, "lock must never be empty on disk");
  assert.equal(JSON.parse(body).pid, 111);
  // No leftover temp file from the atomic publish.
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".new."));
  assert.equal(leftovers.length, 0, "temp create file must be cleaned up");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the writer lock is created exclusively (O_EXCL), not rename-replaced", () => {
  const dir = eventsDir();
  fs.mkdirSync(dir, { recursive: true });
  const got = spool.acquireWriterLock(dir, 111, { now: () => 1 });
  assert.equal(got.ok, true);
  // A concurrent creator using the same exclusive semantics must fail — proving
  // the held lock cannot be silently clobbered by a second create.
  assert.throws(
    () => fs.openSync(path.join(dir, ".writer.lock"), "wx"),
    /EEXIST/,
  );
  // A second acquire by a different live pid does not replace the owner.
  const denied = spool.acquireWriterLock(dir, 222, {
    isAlive: () => true,
    now: () => 2,
  });
  assert.equal(denied.ok, false);
  const owner = JSON.parse(
    fs.readFileSync(path.join(dir, ".writer.lock"), "utf8"),
  );
  assert.equal(owner.pid, 111, "owner pid was replaced on contention");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("releaseWriterLock does not delete a lock it does not own", () => {
  const dir = eventsDir();
  fs.mkdirSync(dir, { recursive: true });
  spool.acquireWriterLock(dir, 111, { now: () => 1 });
  const released = spool.releaseWriterLock(dir, 999); // not the owner
  assert.equal(released, false);
  assert.ok(fs.existsSync(path.join(dir, ".writer.lock")), "lock preserved");
  assert.equal(spool.releaseWriterLock(dir, 111), true);
});

// ── C#7: rotate offset-key consistency (no re-ingest of a rotated day) ──

test("rotate clears the offset for its own promotion key", () => {
  const dir = eventsDir();
  const store = new EventStore(dir);
  const sd = path.join(dir, "spool");
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(
    path.join(sd, "2020-01-01.ndjson"),
    JSON.stringify(ev("old", "session.start", 1577836800000)) + "\n",
  );
  assert.equal(store.promoteSpool(), 1);
  store.rotate(1, 1893456000000); // cutoff far after 2020-01-01
  assert.ok(
    !fs.existsSync(path.join(sd, "2020-01-01.ndjson")),
    "rotated spool file removed",
  );
  assert.equal(store.offsets["2020-01-01.ndjson"], undefined, "offset cleared");
});

// ── Round-K EVT1: a torn trailing STORE record must not glue+lose the next one ──

test("a torn trailing store record is isolated, and a re-promoted event survives", () => {
  const dir = eventsDir();
  const storeDir = path.join(dir, "store");
  const spoolDir = path.join(dir, "spool");
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(spoolDir, { recursive: true });
  const ts = Date.parse("2020-03-04T00:00:00Z");
  const day = "2020-03-04";
  const A = ev("A", "prompt.submit", ts);
  const B = ev("B", "prompt.submit", ts);
  const X = ev("X", "prompt.submit", ts);
  // Store holds A, B, then a TORN X (crash mid-append: no trailing newline).
  fs.writeFileSync(
    path.join(storeDir, `${day}.ndjson`),
    JSON.stringify(A) +
      "\n" +
      JSON.stringify(B) +
      "\n" +
      JSON.stringify(X).slice(0, 14),
  );
  // The spool holds the COMPLETE X; its offset is behind X (never promoted).
  fs.writeFileSync(
    path.join(spoolDir, `${day}.ndjson`),
    JSON.stringify(X) + "\n",
  );

  const s1 = new EventStore(dir);
  assert.ok(s1.seen.has("A") && s1.seen.has("B"), "A,B load from the store");
  assert.ok(!s1.seen.has("X"), "the torn X is skipped, not half-parsed");
  s1.promoteSpool();
  assert.ok(s1.seen.has("X"), "X is promoted from the spool");

  // A fresh reload must still see X — the torn prefix stays an isolated skip,
  // not glued onto the fresh record (which would make both unparseable).
  const s2 = new EventStore(dir);
  assert.ok(s2.seen.has("X"), "re-promoted X survives the restart");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Round-K EVT2: the attention banner is order-independent at an equal-ms tie ──

test("attention is order-independent when two sources share a timestamp", () => {
  const a = ev("a", "permission.denied", 1000, { data: { tool: "Bash" } });
  const b = ev("b", "policy.denied", 1000, {
    data: { tool: "Write", code: "X" },
  });
  const fwd = new Map();
  applyEvent(fwd, a, 1000);
  applyEvent(fwd, b, 1000);
  const rev = new Map();
  applyEvent(rev, b, 1000);
  applyEvent(rev, a, 1000);
  assert.equal(
    fwd.get("s1").attention,
    rev.get("s1").attention,
    "equal-ms attention must not depend on delivery order",
  );
});

// ── Round-L EVT: same-KIND attention at one ts is also order-independent ──

test("attention is order-independent for two SAME-kind events at one timestamp", () => {
  const a = ev("a", "permission.denied", 1000, { data: { tool: "Bash" } });
  const b = ev("b", "permission.denied", 1000, { data: { tool: "Write" } });
  const fwd = new Map();
  applyEvent(fwd, a, 1000);
  applyEvent(fwd, b, 1000);
  const rev = new Map();
  applyEvent(rev, b, 1000);
  applyEvent(rev, a, 1000);
  assert.equal(
    fwd.get("s1").attention,
    rev.get("s1").attention,
    "same-kind equal-ms attention must not depend on delivery order",
  );
});

// ── Round-L EVT: the lock heartbeat survives a transient rename hiccup ──

test("Round-L: touchWriterLock never falsely demotes the owner (rename-hiccup safe)", () => {
  const dir = eventsDir();
  fs.mkdirSync(dir, { recursive: true });
  // acquire (linkSync) then touch (rename over the just-linked file) is the
  // shape that intermittently EPERM'd on Windows. The owner's heartbeat must
  // report retained ownership every time; loop to shake out the race.
  for (let i = 0; i < 250; i++) {
    fs.rmSync(path.join(dir, ".writer.lock"), { force: true });
    assert.equal(spool.acquireWriterLock(dir, 222, { now: () => 1 }).ok, true);
    assert.equal(
      spool.touchWriterLock(dir, 222, 2),
      true,
      `owner heartbeat must hold (iter ${i})`,
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Round-M EVT: masking a failed heartbeat is bounded to the reclaim TTL ──

test("Round-M: a failed heartbeat retains a FRESH lock but demotes a stale one", () => {
  const TTL = spool.LOCK_TTL_MS;
  // retainOnFailedRefresh is the decision touchWriterLock makes when the atomic
  // publish fails: keep ownership only while the last heartbeat is still fresh
  // (a transient hiccup); demote once it is old enough to be reclaimed, so a
  // frozen writer can never double-write alongside a new owner.
  assert.equal(
    spool.retainOnFailedRefresh({ pid: 7, at: 1000 }, 7, 1000 + 5),
    true,
  );
  assert.equal(
    spool.retainOnFailedRefresh({ pid: 7, at: 1000 }, 7, 1000 + TTL),
    false,
  );
  assert.equal(
    spool.retainOnFailedRefresh({ pid: 9, at: 1000 }, 7, 1001),
    false,
  );
  assert.equal(spool.retainOnFailedRefresh(null, 7, 1001), false);
});

// ── Round-N EVT: a torn SPOOL record must not glue+lose the next appended event ──

test("a torn spool record is isolated, and a later durable append survives", () => {
  const dir = eventsDir();
  const ts = Date.parse("2020-05-06T00:00:00Z");
  const day = spool.dateStr(ts);
  spool.appendSpool(dir, ev("A", "prompt.submit", ts), ts); // complete
  // A crash leaves a torn record B with no trailing newline.
  const file = path.join(dir, "spool", `${day}.ndjson`);
  fs.appendFileSync(
    file,
    JSON.stringify(ev("B", "prompt.submit", ts)).slice(0, 18),
  );
  // A later durable append must NOT glue onto the torn B.
  spool.appendSpool(dir, ev("C", "prompt.submit", ts), ts);

  const store = new EventStore(dir);
  store.promoteSpool();
  assert.ok(store.seen.has("A"), "A promoted");
  assert.ok(
    store.seen.has("C"),
    "C (durable, after a torn record) must survive",
  );
  assert.ok(!store.seen.has("B"), "the torn B stays an isolated skip");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Round-O EVT: cwd is delivery-order-independent, incl. non-state events ──

test("cwd is order-independent (newest ts wins, even across non-state events)", () => {
  const A = ev("A", "prompt.submit", 100, { cwd: "/a" });
  const B = ev("B", "task.created", 200, { cwd: "/b" }); // non-state, newer
  const fwd = new Map();
  applyEvent(fwd, A, 1000);
  applyEvent(fwd, B, 1000);
  const rev = new Map();
  applyEvent(rev, B, 1000);
  applyEvent(rev, A, 1000);
  assert.equal(fwd.get("s1").cwd, "/b");
  assert.equal(
    rev.get("s1").cwd,
    "/b",
    "cwd must not depend on delivery order",
  );
});

// ── Round-P EVT: cwd order-independence for a far-future (suspect) event ──

test("cwd never latches from a suspect-future event (seed clamp)", () => {
  const now = 1_000_000_000_000;
  const FUTURE = now + 10 * 60 * 1000; // > 5min skew
  const A = ev("A", "tool.pre", FUTURE, { cwd: "/evil" });
  const B = ev("B", "task.created", now - 1000, { cwd: null });
  const fwd = new Map();
  applyEvent(fwd, A, now);
  applyEvent(fwd, B, now);
  const rev = new Map();
  applyEvent(rev, B, now);
  applyEvent(rev, A, now);
  assert.equal(
    fwd.get("s1").cwd,
    null,
    "a suspect-future cwd must never latch",
  );
  assert.equal(rev.get("s1").cwd, null, "order-independent");
});

// ── Round-P EVT: cwd order-independence at an equal-ts tie ──

test("cwd is order-independent at an equal-ts tie (deterministic winner)", () => {
  const now = 1_000_000_000_000;
  const A = ev("A", "tool.pre", now - 5000, { cwd: "/a" });
  const B = ev("B", "tool.post", now - 5000, { cwd: "/b" });
  const fwd = new Map();
  applyEvent(fwd, A, now);
  applyEvent(fwd, B, now);
  const rev = new Map();
  applyEvent(rev, B, now);
  applyEvent(rev, A, now);
  assert.equal(
    fwd.get("s1").cwd,
    rev.get("s1").cwd,
    "equal-ts cwd must not depend on delivery order",
  );
});

// ── Round-P EVT: appendSpool self-frames every record (race-safe) ──

test("appendSpool self-frames every record so a torn one cannot glue-lose", () => {
  const dir = eventsDir();
  const ts = Date.parse("2020-06-07T00:00:00Z");
  const day = spool.dateStr(ts);
  const file = path.join(dir, "spool", `${day}.ndjson`);
  spool.appendSpool(dir, ev("A", "prompt.submit", ts), ts);
  spool.appendSpool(dir, ev("C", "prompt.submit", ts), ts);
  // Unconditional leading newline (no read->append TOCTOU): a blank line frames
  // each record, so a torn predecessor is isolated regardless of interleaving.
  assert.match(fs.readFileSync(file, "utf8"), /\}\n\n\{"v":1,"id":"C"/);
  // A tear appearing after the last append still isolates on the next append.
  fs.appendFileSync(
    file,
    JSON.stringify(ev("B", "prompt.submit", ts)).slice(0, 18),
  );
  spool.appendSpool(dir, ev("D", "prompt.submit", ts), ts);
  const store = new EventStore(dir);
  store.promoteSpool();
  for (const id of ["A", "C", "D"])
    assert.ok(store.seen.has(id), `${id} survives`);
  assert.ok(!store.seen.has("B"), "torn B isolated");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Round-P EVT: store _append self-frames too (transient multi-writer glue-safe) ──

test("store _append self-frames every record", () => {
  const dir = eventsDir();
  const ts = Date.parse("2020-06-08T00:00:00Z");
  const store = new EventStore(dir);
  store.ingest(ev("A", "prompt.submit", ts));
  store.ingest(ev("B", "prompt.submit", ts));
  const bytes = fs.readFileSync(
    path.join(dir, "store", "2020-06-08.ndjson"),
    "utf8",
  );
  assert.match(
    bytes,
    /\}\n\n\{"v":1,"id":"B"/,
    "each store record self-frames",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Round-P EVT: sharedRuntimeRoot rejects an up-then-down commondir ──

test("sharedRuntimeRoot rejects an up-then-down commondir (no escape)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "srr-"));
  const wt = path.join(tmp, "wt");
  const gd = path.join(tmp, "gd");
  const evil = path.join(tmp, "evil");
  for (const d of [wt, gd, evil]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gd}\n`);
  // A commondir that goes UP then DOWN into an unrelated dir must not be trusted.
  fs.writeFileSync(path.join(gd, "commondir"), path.relative(gd, evil) + "\n");
  assert.equal(
    spool.sharedRuntimeRoot(wt),
    wt,
    "must not relocate the control plane outside the checkout",
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Round-Q EVT: cwd order-independent even for a non-positive ts (argmax base) ──

test("cwd is order-independent for a ts <= 0 event", () => {
  const now = 1_000_000_000_000;
  const A = ev("A", "prompt.submit", -5, { cwd: "/d" }); // non-suspect, ts <= 0
  const B = ev("B", "prompt.submit", now + 300001, { cwd: "/d" }); // suspect-future
  const fwd = new Map();
  applyEvent(fwd, A, now);
  applyEvent(fwd, B, now);
  const rev = new Map();
  applyEvent(rev, B, now);
  applyEvent(rev, A, now);
  assert.equal(fwd.get("s1").cwd, "/d");
  assert.equal(
    rev.get("s1").cwd,
    "/d",
    "cwd must not depend on delivery order",
  );
});
