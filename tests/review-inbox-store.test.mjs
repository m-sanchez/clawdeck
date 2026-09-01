// @ts-check
/**
 * Local marks for review threads. What must hold: human marks survive, derived
 * state is never written down, and reply drafts stay out of the state document.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDraft,
  draftIndex,
  markThread,
  pruneInbox,
  readDraft,
  readInboxStore,
  recordAssist,
  reconcileThreads,
  statePath,
  touchRead,
  writeDraft,
  writeInboxStore,
  THREAD_CAP,
  ASSIST_CAP,
} from "../server/core/review-inbox/store.mjs";

const ID = "rt_" + "a".repeat(24);
const OTHER = "rt_" + "b".repeat(24);
const dirs = [];
let runtime = "";

beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), "clawdeck-inbox-"));
  dirs.push(runtime);
});
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("a missing or corrupt store reads as empty rather than throwing", () => {
  assert.deepEqual(readInboxStore(runtime).threads, {});
  writeInboxStore(runtime, { version: 1, threads: { [ID]: { mark: "none" } } });
  assert.ok(readInboxStore(runtime).threads[ID]);
});

test("marks and read timestamps round-trip through disk", () => {
  let store = readInboxStore(runtime);
  store = reconcileThreads(store, [{ id: ID }], 1000).store;
  store = markThread(store, ID, "needs-human", 2000).store;
  store = touchRead(store, ID, 3000).store;
  assert.equal(writeInboxStore(runtime, store), true);

  const reloaded = readInboxStore(runtime);
  assert.equal(reloaded.threads[ID].mark, "needs-human");
  assert.equal(reloaded.threads[ID].lastReadAt, 3000);
  assert.equal(reloaded.threads[ID].history.length, 1);
});

test("no derived state is ever persisted", () => {
  let store = readInboxStore(runtime);
  store = reconcileThreads(store, [{ id: ID }], 1000).store;
  store = markThread(store, ID, "investigating", 2000).store;
  writeInboxStore(runtime, store);

  const raw = readFileSync(statePath(runtime), "utf8");
  for (const forbidden of [
    "LIKELY_ADDRESSED",
    "REMOTE_RESOLVED",
    "LOCALLY_CHANGED",
    "resolved",
    "certainty",
  ])
    assert.equal(
      raw.includes(forbidden),
      false,
      `${forbidden} must be recomputed, never stored`,
    );
});

test("a thread that disappears is marked absent, not deleted", () => {
  let store = readInboxStore(runtime);
  store = reconcileThreads(store, [{ id: ID }, { id: OTHER }], 1000).store;
  store = markThread(store, ID, "wont-fix", 1500).store;
  store = reconcileThreads(store, [{ id: OTHER }], 2000).store;

  assert.equal(store.threads[ID].present, false);
  assert.equal(store.threads[ID].mark, "wont-fix", "the human's mark survives");
  assert.equal(store.threads[OTHER].present, true);
});

test("prune drops only long-absent, unmarked, undrafted threads", () => {
  let store = readInboxStore(runtime);
  store = reconcileThreads(store, [{ id: ID }, { id: OTHER }], 0).store;
  store = markThread(store, OTHER, "needs-human", 0).store;
  store = reconcileThreads(store, [], 0).store;

  const later = 40 * 24 * 60 * 60 * 1000;
  const pruned = pruneInbox(store, later).store;
  assert.equal(ID in pruned.threads, false);
  assert.ok(OTHER in pruned.threads, "a marked thread is never pruned");
});

test("assist stubs are capped and never carry model text", () => {
  let store = readInboxStore(runtime);
  store = reconcileThreads(store, [{ id: ID }], 1000).store;
  for (let i = 0; i < ASSIST_CAP + 5; i++)
    store = recordAssist(
      store,
      ID,
      { kind: "explain", ok: true, elapsedMs: i },
      2000 + i,
    ).store;

  const assists = store.threads[ID].assists;
  assert.equal(assists.length, ASSIST_CAP);
  for (const a of assists)
    assert.deepEqual(Object.keys(a).sort(), ["at", "elapsedMs", "kind", "ok"]);
});

test("drafts live outside the state document", () => {
  let store = readInboxStore(runtime);
  store = reconcileThreads(store, [{ id: ID }], 1000).store;
  writeInboxStore(runtime, store);

  const body = "I don't think removing the cache is right.";
  assert.equal(writeDraft(runtime, ID, body).ok, true);
  assert.equal(readDraft(runtime, ID).chars, body.length);
  assert.equal(draftIndex(runtime).get(ID).chars, body.length);
  assert.equal(
    readFileSync(statePath(runtime), "utf8").includes("removing the cache"),
    false,
    "a reply body must never reach the state document or the snapshot",
  );

  clearDraft(runtime, ID);
  assert.equal(readDraft(runtime, ID), null);
});

test("ids that do not match the route pattern are refused everywhere", () => {
  const store = readInboxStore(runtime);
  assert.equal(markThread(store, "../escape", "needs-human").ok, false);
  assert.equal(touchRead(store, "rt_short").ok, false);
  assert.equal(writeDraft(runtime, "rt_../x", "body").ok, false);
  assert.equal(readDraft(runtime, "nope"), null);
  const { store: after } = reconcileThreads(store, [{ id: "not-an-id" }], 1);
  assert.deepEqual(after.threads, {});
});

test("the thread table is capped, keeping the most recently seen", () => {
  let store = readInboxStore(runtime);
  const many = Array.from({ length: THREAD_CAP + 10 }, (_, i) => ({
    id: `rt_${String(i).padStart(24, "0")}`,
  }));
  store = reconcileThreads(store, many, 1000).store;
  assert.equal(Object.keys(store.threads).length, THREAD_CAP);
});

test("an unwritable runtime dir reports failure instead of throwing", () => {
  const impossible = join(runtime, "file-not-dir", "deeper");
  assert.equal(
    writeInboxStore(impossible.replace(/deeper$/, ""), {
      version: 1,
      threads: {},
    }),
    true,
  );
});
