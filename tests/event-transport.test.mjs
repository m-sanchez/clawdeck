// @ts-check
/**
 * EVT1 regression tests: events emitted from ANY worktree of the repository
 * reach ONE canonical control-plane root (the main checkout's runtime dir),
 * discovered via pure .git-file parsing (no subprocess). Offline events spool
 * durably and are promoted when the panel comes back; concurrent worktree
 * emitters do not collide; a deleted worktree's events still promote.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { EventStore } from "../server/core/events/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT = path.resolve(here, "..");
const require_ = createRequire(import.meta.url);
const spool = require_(
  path.join(CHECKOUT, "hooks", "lib", "event-spool.cjs"),
);
const EMIT = path.join(CHECKOUT, "hooks", "emit-event.cjs");

/** Build a fake main repo + N linked worktrees (git layout only, no git). */
function makeRepo(tmp, worktreeNames) {
  const main = path.join(tmp, "main");
  fs.mkdirSync(path.join(main, ".git"), { recursive: true });
  const trees = {};
  for (const name of worktreeNames) {
    const wt = path.join(tmp, name);
    fs.mkdirSync(wt, { recursive: true });
    const gitdir = path.join(main, ".git", "worktrees", name);
    fs.mkdirSync(gitdir, { recursive: true });
    // Real git writes commondir as a path relative to the worktree gitdir.
    fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);
    trees[name] = wt;
  }
  return { main, trees };
}

test("sharedRuntimeRoot: main checkout resolves to itself", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evt1-"));
  const { main } = makeRepo(tmp, []);
  assert.equal(spool.sharedRuntimeRoot(main), main);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sharedRuntimeRoot: linked worktree resolves to the main checkout", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evt1-"));
  const { main, trees } = makeRepo(tmp, ["wtA"]);
  assert.equal(spool.sharedRuntimeRoot(trees.wtA), main);
  assert.equal(
    spool.sharedEventsDir(trees.wtA),
    path.join(main, ".claude", ".runtime", "events"),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sharedRuntimeRoot: relative gitdir + missing metadata degrade safely", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evt1-"));
  const { main, trees } = makeRepo(tmp, ["wtB"]);
  // Rewrite as a RELATIVE gitdir pointer (git sometimes does this).
  fs.writeFileSync(
    path.join(trees.wtB, ".git"),
    `gitdir: ../main/.git/worktrees/wtB\n`,
  );
  assert.equal(spool.sharedRuntimeRoot(trees.wtB), main);

  // A directory with no .git at all falls back to itself.
  const plain = path.join(tmp, "plain");
  fs.mkdirSync(plain);
  assert.equal(spool.sharedRuntimeRoot(plain), plain);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function emitFrom(checkoutRoot, payload) {
  execFileSync(process.execPath, [EMIT], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      CLAUDE_EVENTS_CHECKOUT_ROOT: checkoutRoot,
      // Point the live POST at a dead port so only the spool path is exercised.
      PANEL_SERVICE_PORT: "1",
    },
    windowsHide: true,
    timeout: 15000,
  });
}

function readSharedSpool(main) {
  const dir = path.join(main, ".claude", ".runtime", "events", "spool");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
  return files.flatMap((f) =>
    fs
      .readFileSync(path.join(dir, f), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
}

test("EVT1.1/1.2/1.4: two worktrees emit concurrently into ONE canonical spool with attribution", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evt1-"));
  const { main, trees } = makeRepo(tmp, ["wtA", "wtB"]);
  emitFrom(trees.wtA, {
    hook_event_name: "UserPromptSubmit",
    session_id: "sessA",
    cwd: trees.wtA,
    prompt: "hello from A",
  });
  emitFrom(trees.wtB, {
    hook_event_name: "Stop",
    session_id: "sessB",
    cwd: trees.wtB,
  });
  const events = readSharedSpool(main);
  assert.equal(events.length, 2, "both worktree events in the shared spool");
  const a = events.find((e) => e.session_id === "sessA");
  const b = events.find((e) => e.session_id === "sessB");
  assert.ok(a && b);
  assert.equal(a.event, "prompt.submit");
  assert.equal(a.cwd, trees.wtA, "source worktree attributed via cwd");
  assert.equal(b.cwd, trees.wtB);
  assert.notEqual(a.id, b.id);
  // redaction still holds through the shared path
  assert.ok(!JSON.stringify(a).includes("hello from A"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("EVT1.3: panel-offline events are promoted into the canonical store on restart", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evt1-"));
  const { main, trees } = makeRepo(tmp, ["wtA"]);
  emitFrom(trees.wtA, {
    hook_event_name: "SessionStart",
    session_id: "sessOff",
    cwd: trees.wtA,
  });
  emitFrom(trees.wtA, {
    hook_event_name: "Stop",
    session_id: "sessOff",
    cwd: trees.wtA,
  });
  // "Panel restart": a fresh store over the shared events dir promotes both.
  const store = new EventStore(spool.sharedEventsDir(trees.wtA));
  const promoted = store.promoteSpool();
  assert.equal(promoted, 2);
  const snap = store.snapshot();
  const sess = snap.sessions.find((s) => s.sessionId === "sessOff");
  assert.ok(sess, "session projected from spooled events");
  assert.equal(sess.state, "idle");
  // Second promotion pass is idempotent.
  assert.equal(store.promoteSpool(), 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("EVT1.5: events from a deleted worktree still promote without crashing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evt1-"));
  const { main, trees } = makeRepo(tmp, ["wtGone"]);
  emitFrom(trees.wtGone, {
    hook_event_name: "SessionStart",
    session_id: "ghost",
    cwd: trees.wtGone,
  });
  fs.rmSync(trees.wtGone, { recursive: true, force: true });
  const store = new EventStore(
    path.join(main, ".claude", ".runtime", "events"),
  );
  assert.equal(store.promoteSpool(), 1);
  const sess = store.snapshot().sessions.find((s) => s.sessionId === "ghost");
  assert.ok(sess);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("ingest descriptor: panel writes {token, port}; the emitter reads both", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evt1-"));
  const dir = path.join(tmp, "events");
  spool.writeIngestDescriptor(dir, { token: "tok123", port: 4390 });
  assert.deepEqual(spool.readIngestDescriptor(dir), {
    token: "tok123",
    port: 4390,
  });
  // Legacy plain-token file still readable (older panels wrote ingest.token).
  const legacy = path.join(tmp, "legacy");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "ingest.token"), "plain\n");
  assert.equal(spool.readIngestDescriptor(legacy).token, "plain");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("canonical writer lock: live owner holds, dead owner is reclaimed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evt1-"));
  const dir = path.join(tmp, "events");
  const got = spool.acquireWriterLock(dir, process.pid);
  assert.equal(got.ok, true);
  // A second acquire by another (fake) pid must fail while the owner lives.
  const denied = spool.acquireWriterLock(dir, 999999999);
  assert.equal(denied.ok, false);
  assert.equal(denied.ownerPid, process.pid);
  // Simulate a dead owner: rewrite the lock with an impossible pid, reclaim.
  spool.releaseWriterLock(dir, process.pid);
  const stale = spool.acquireWriterLock(dir, process.pid, {
    isAlive: () => false,
  });
  assert.equal(stale.ok, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});
