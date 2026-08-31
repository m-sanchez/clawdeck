// @ts-check
/** Unit tests for the single-writer event store + spool promotion. node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../server/core/events/store.mjs";

function eventsDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ev-")), "events");
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
function writeSpool(dir, day, events) {
  const sd = path.join(dir, "spool");
  fs.mkdirSync(sd, { recursive: true });
  fs.appendFileSync(
    path.join(sd, `${day}.ndjson`),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}
function countStore(dir) {
  const sd = path.join(dir, "store");
  let n = 0;
  for (const f of fs.readdirSync(sd).filter((x) => x.endsWith(".ndjson"))) {
    n += fs
      .readFileSync(path.join(sd, f), "utf8")
      .split("\n")
      .filter((l) => l.trim()).length;
  }
  return n;
}

test("ingest is idempotent by id (one store line)", () => {
  const dir = eventsDir();
  const store = new EventStore(dir);
  const e = ev("e1", "session.start", 1735689600000);
  assert.equal(store.ingest(e).ok, true);
  assert.equal(store.ingest(e).duplicate, true);
  assert.equal(countStore(dir), 1);
});

test("promoteSpool promotes new lines and advances the offset", () => {
  const dir = eventsDir();
  const store = new EventStore(dir);
  writeSpool(dir, "2025-01-01", [
    ev("a", "session.start", 1735689600000),
    ev("b", "prompt.submit", 1735689601000),
  ]);
  assert.equal(store.promoteSpool(), 2);
  assert.equal(countStore(dir), 2);
  assert.equal(store.promoteSpool(), 0); // offset advanced: nothing new
});

test("double-delivery (live POST + spool) stores exactly once", () => {
  const dir = eventsDir();
  const store = new EventStore(dir);
  const e = ev("dup", "session.start", 1735689600000);
  store.ingest(e); // live
  writeSpool(dir, "2025-01-01", [e]); // same id via spool
  assert.equal(store.promoteSpool(), 0); // recognized as duplicate
  assert.equal(countStore(dir), 1);
});

test("a new store instance rebuilds seen-ids and the projection", () => {
  const dir = eventsDir();
  let store = new EventStore(dir);
  store.ingest(ev("e1", "session.start", 1735689600000));
  store.ingest(ev("e2", "stop", 1735689601000));

  store = new EventStore(dir); // fresh instance, same dir
  assert.equal(store.ingest(ev("e1", "session.start", 1)).duplicate, true);
  assert.equal(store.snapshot().sessions[0].state, "idle"); // stop replayed
});

test("a torn spool line is skipped, valid lines still promote", () => {
  const dir = eventsDir();
  const store = new EventStore(dir);
  const sd = path.join(dir, "spool");
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(
    path.join(sd, "2025-01-01.ndjson"),
    JSON.stringify(ev("ok1", "session.start", 1735689600000)) +
      "\n{ torn json\n" +
      JSON.stringify(ev("ok2", "stop", 1735689601000)) +
      "\n",
  );
  assert.equal(store.promoteSpool(), 2);
  assert.equal(countStore(dir), 2);
});
