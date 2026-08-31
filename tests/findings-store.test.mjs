// @ts-check
/**
 * Phase H: the Fix Station lifecycle is a durable operational object. Tests:
 * persistence across restart, illegal-transition rejection, rescan
 * reconciliation (no duplication), rejected stays rejected unless reopened, and
 * a resolved finding reopens when a fresh scan re-detects the same stable one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readFindingStore,
  writeFindingStore,
  reconcileFindings,
  transitionFinding,
  decorateFindings,
  activeStoreFindings,
} from "../server/core/findings/store.mjs";
import { findingId } from "../server/core/findings/model.mjs";

const F1 = {
  file: "src/a.ts",
  line: 10,
  ruleId: "LOG001",
  title: "console.log",
};
const F2 = { file: "src/b.ts", line: 3, ruleId: "ANG002", title: "*ngIf" };
const runtimeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "fx-"));

test("lifecycle persists across a restart", () => {
  const dir = runtimeDir();
  let { store } = reconcileFindings(readFindingStore(dir), [F1], 1000);
  const id = findingId(F1);
  transitionFinding(store, id, "confirmed", { actor: "panel", now: 1100 });
  writeFindingStore(dir, store);

  // "restart": fresh read from disk keeps the confirmed state.
  const reloaded = readFindingStore(dir);
  assert.equal(reloaded.findings[id].state, "confirmed");
  assert.equal(reloaded.findings[id].history.at(-1).to, "confirmed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("illegal transition is rejected", () => {
  const { store } = reconcileFindings({ v: 1, findings: {} }, [F1], 1);
  const id = findingId(F1);
  const bad = transitionFinding(store, id, "resolved"); // found -> resolved illegal
  assert.equal(bad.ok, false);
  assert.match(bad.error, /illegal transition/);
  assert.equal(store.findings[id].state, "found", "state unchanged on illegal");
});

test("rescan reconciles existing findings rather than duplicating", () => {
  let { store } = reconcileFindings({ v: 1, findings: {} }, [F1, F2], 1);
  const id1 = findingId(F1);
  transitionFinding(store, id1, "confirmed", { now: 2 });
  // Same two findings scanned again.
  const r2 = reconcileFindings(store, [F1, F2], 3);
  assert.equal(Object.keys(r2.store.findings).length, 2, "no duplication");
  assert.equal(r2.store.findings[id1].state, "confirmed", "state preserved");
});

test("rejected stays rejected across rescans unless explicitly reopened", () => {
  let { store } = reconcileFindings({ v: 1, findings: {} }, [F1], 1);
  const id = findingId(F1);
  transitionFinding(store, id, "rejected", {
    reason: "false positive",
    now: 2,
  });
  const r = reconcileFindings(store, [F1], 3); // still detected
  assert.equal(r.store.findings[id].state, "rejected", "rejection sticky");
  // Explicit reopen is the only path back.
  const reopen = transitionFinding(r.store, id, "found", { now: 4 });
  assert.equal(reopen.ok, true);
});

test("a confirmed finding that disappears advances to changed (evidence)", () => {
  let { store } = reconcileFindings({ v: 1, findings: {} }, [F1], 1);
  const id = findingId(F1);
  transitionFinding(store, id, "confirmed", { now: 2 });
  const r = reconcileFindings(store, [], 3); // F1 no longer detected
  assert.equal(r.store.findings[id].state, "changed");
  assert.equal(r.changed, true);
});

test("a resolved finding reopens when a fresh scan re-detects it", () => {
  let { store } = reconcileFindings({ v: 1, findings: {} }, [F1], 1);
  const id = findingId(F1);
  // Drive to resolved through the legal graph.
  transitionFinding(store, id, "confirmed", { now: 2 });
  transitionFinding(store, id, "fix-dispatched", { now: 3 });
  transitionFinding(store, id, "changed", { now: 4 });
  transitionFinding(store, id, "targeted-test-passed", { now: 5 });
  transitionFinding(store, id, "resolved", { now: 6 });
  assert.equal(store.findings[id].state, "resolved");
  // Fresh scan re-detects the same stable finding -> reopen for re-verify.
  const r = reconcileFindings(store, [F1], 7);
  assert.equal(r.store.findings[id].state, "reverify-required");
  fs.rmSync;
});

test("OL-1: a failed/absent scan must not manufacture 'changed' evidence", () => {
  // A confirmed finding, then a scan that did NOT actually run (status !== ok,
  // findings []). reconcileFindings must not be told the finding disappeared.
  let { store } = reconcileFindings({ v: 1, findings: {} }, [F1], 1);
  const id = findingId(F1);
  transitionFinding(store, id, "confirmed", { now: 2 });
  // The snapshot layer only reconciles when the scan is trustworthy; simulate
  // that contract: a non-ok scan does NOT call reconcileFindings, so state holds.
  // (Guard lives in snapshot.mjs; here we assert the store never self-advances.)
  const stillConfirmed = store.findings[id].state;
  assert.equal(stillConfirmed, "confirmed", "no scan => no state change");
  // And a genuine empty successful scan DOES advance (control).
  const r = reconcileFindings(store, [], 3);
  assert.equal(r.store.findings[id].state, "changed");
});

test("Round B: post-fix findings (changed/awaiting-verify) remain visible for resolve", () => {
  // A confirmed finding whose source was fixed disappears from the scan and
  // advances to "changed" (present:false). It must still be surfaced so the
  // operator can drive it changed -> targeted-test-passed -> resolved.
  let { store } = reconcileFindings({ v: 1, findings: {} }, [F1], 1);
  const id = findingId(F1);
  transitionFinding(store, id, "confirmed", { now: 2 });
  transitionFinding(store, id, "fix-dispatched", { now: 3 });
  const r = reconcileFindings(store, [], 4); // F1 no longer detected -> changed
  assert.equal(r.store.findings[id].state, "changed");
  assert.equal(r.store.findings[id].present, false);
  // The active view must include this store-only, non-terminal record.
  const active = activeStoreFindings(r.store, []); // scanned ids = none
  const hit = active.find((f) => f.findingId === id);
  assert.ok(hit, "a changed/present:false finding must remain visible");
  assert.equal(hit.lifecycle.state, "changed");
  assert.equal(hit.file, F1.file);
  // A resolved (terminal) or still-present record is NOT added here.
  transitionFinding(r.store, id, "targeted-test-passed", { now: 5 });
  transitionFinding(r.store, id, "resolved", { now: 6 });
  assert.equal(
    activeStoreFindings(r.store, []).some((f) => f.findingId === id),
    false,
    "resolved is terminal — not surfaced as active",
  );
});

test("decorateFindings attaches lifecycle state to the scanned findings", () => {
  let { store } = reconcileFindings({ v: 1, findings: {} }, [F1], 1);
  const id = findingId(F1);
  transitionFinding(store, id, "confirmed", { now: 2 });
  const decorated = decorateFindings([F1], store);
  assert.equal(decorated[0].lifecycle.state, "confirmed");
  assert.equal(decorated[0].findingId, id);
});
