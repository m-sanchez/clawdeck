// @ts-check
/**
 * EVT2/EVT3 regression tests: projected session state never moves BACKWARDS on
 * late/duplicate delivery (effective-timestamp ordering, id-set subagent
 * accounting), and a partial trailing spool record is retried instead of being
 * permanently skipped by the offset high-water mark.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../server/core/events/store.mjs";
import { applyEvent } from "../server/core/events/projection.mjs";

function eventsDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "evc-")), "events");
}
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

// ── EVT2.1: a late OLDER event must not regress the state ──

test("EVT2.1: stop first, older prompt promoted later -> session stays idle", () => {
  const store = new EventStore(eventsDir());
  store.ingest(ev("live-stop", "stop", 2000));
  store.ingest(ev("late-prompt", "prompt.submit", 1000)); // older, arrives late
  const s = store.snapshot().sessions.find((x) => x.sessionId === "s1");
  assert.equal(
    s.state,
    "idle",
    "older prompt.submit must not revive the session",
  );
  assert.equal(s.prompts, 1, "counters still count the late event");
  assert.equal(s.lastEventAt, 2000);
});

test("EVT2.1b: a NEWER prompt after stop legitimately re-runs the session", () => {
  const store = new EventStore(eventsDir());
  store.ingest(ev("stop1", "stop", 2000));
  store.ingest(ev("p2", "prompt.submit", 3000));
  const s = store.snapshot().sessions.find((x) => x.sessionId === "s1");
  assert.equal(s.state, "running");
});

// ── EVT2.2: subagent stop before delayed start (id-based accounting) ──

test("EVT2.2: subagent stop arriving before its start leaves zero active", () => {
  const sessions = new Map();
  applyEvent(
    sessions,
    ev("stopA", "subagent.stop", 1600, {
      agent_id: "agA",
      agent_type: "Explore",
    }),
  );
  applyEvent(
    sessions,
    ev("startA", "subagent.start", 1500, {
      agent_id: "agA",
      agent_type: "Explore",
    }),
  );
  const s = sessions.get("s1");
  assert.equal(
    s.subagents,
    0,
    "late start of an already-stopped agent must not leak",
  );
  assert.equal(s.subagentStarts, 1, "the start is still counted historically");
});

// ── EVT2.3: duplicate start/stop delivery is idempotent ──

test("EVT2.3: duplicated start/stop envelopes leave an idempotent final state", () => {
  const sessions = new Map();
  const start = ev("st", "subagent.start", 100, { agent_id: "agB" });
  const stop = ev("sp", "subagent.stop", 200, { agent_id: "agB" });
  // Same agent id delivered twice under distinct envelope ids (worst case).
  applyEvent(sessions, start);
  applyEvent(sessions, { ...start, id: "st2" });
  const mid = sessions.get("s1");
  assert.equal(
    mid.subagents,
    1,
    "duplicate start of the same agent id counts once",
  );
  applyEvent(sessions, stop);
  applyEvent(sessions, { ...stop, id: "sp2" });
  assert.equal(sessions.get("s1").subagents, 0);
});

test("subagents without agent ids still balance via the counter fallback", () => {
  const sessions = new Map();
  applyEvent(
    sessions,
    ev("s1e", "subagent.start", 100, { agent_type: "Explore" }),
  );
  applyEvent(
    sessions,
    ev("s2e", "subagent.start", 110, { agent_type: "Explore" }),
  );
  applyEvent(sessions, ev("x1", "subagent.stop", 120));
  const s = sessions.get("s1");
  assert.equal(s.subagents, 1);
  applyEvent(sessions, ev("x2", "subagent.stop", 130));
  assert.equal(sessions.get("s1").subagents, 0);
  applyEvent(sessions, ev("x3", "subagent.stop", 140));
  assert.equal(sessions.get("s1").subagents, 0, "never negative");
});

// ── EVT2.4: same event live + spool -> projected once ──

test("EVT2.4: an event delivered live AND from the spool is projected once", () => {
  const dir = eventsDir();
  const store = new EventStore(dir);
  const e = ev("dup1", "prompt.submit", 1000);
  store.ingest(e); // live
  const sd = path.join(dir, "spool");
  fs.mkdirSync(sd, { recursive: true });
  fs.appendFileSync(
    path.join(sd, "2025-01-01.ndjson"),
    JSON.stringify(e) + "\n",
  );
  assert.equal(store.promoteSpool(), 0, "spool copy deduped by id");
  const s = store.snapshot().sessions.find((x) => x.sessionId === "s1");
  assert.equal(s.prompts, 1);
});

// ── EVT3: partial trailing record is retried, never skipped ──

test("EVT3: a torn trailing line is completed later and ingested exactly once", () => {
  const dir = eventsDir();
  const store = new EventStore(dir);
  const sd = path.join(dir, "spool");
  fs.mkdirSync(sd, { recursive: true });
  const file = path.join(sd, "2025-01-02.ndjson");
  const full = JSON.stringify(ev("t1", "session.start", 1000)) + "\n";
  const torn = JSON.stringify(ev("t2", "prompt.submit", 2000));
  // First write: one complete line + HALF of the next (no trailing newline).
  fs.writeFileSync(file, full + torn.slice(0, 25));
  assert.equal(store.promoteSpool(), 1, "only the complete line promotes");
  // Second write completes the torn line.
  fs.appendFileSync(file, torn.slice(25) + "\n");
  assert.equal(store.promoteSpool(), 1, "completed line promotes exactly once");
  assert.equal(store.promoteSpool(), 0, "no re-ingestion afterwards");
  const s = store.snapshot().sessions.find((x) => x.sessionId === "s1");
  assert.equal(s.prompts, 1);
});

test("EVT3b: a malformed COMPLETE line is skipped permanently; later lines survive", () => {
  const dir = eventsDir();
  const store = new EventStore(dir);
  const sd = path.join(dir, "spool");
  fs.mkdirSync(sd, { recursive: true });
  const file = path.join(sd, "2025-01-03.ndjson");
  fs.writeFileSync(
    file,
    `{"broken": true,,,\n` +
      JSON.stringify(ev("ok1", "session.start", 1000)) +
      "\n",
  );
  assert.equal(store.promoteSpool(), 1, "valid record after the malformed one");
  assert.equal(
    store.promoteSpool(),
    0,
    "malformed line is not retried forever",
  );
});

test("EVT3c: a file that is ONLY a partial line does not advance the offset", () => {
  const dir = eventsDir();
  const store = new EventStore(dir);
  const sd = path.join(dir, "spool");
  fs.mkdirSync(sd, { recursive: true });
  const file = path.join(sd, "2025-01-04.ndjson");
  const torn = JSON.stringify(ev("only", "session.start", 1000));
  fs.writeFileSync(file, torn.slice(0, 10));
  assert.equal(store.promoteSpool(), 0);
  fs.appendFileSync(file, torn.slice(10) + "\n");
  assert.equal(store.promoteSpool(), 1);
});
