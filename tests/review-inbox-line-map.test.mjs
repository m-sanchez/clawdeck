// @ts-check
/**
 * Anchor line mapping. The review points at a line in an older revision; the
 * whole "did we address this?" claim rests on knowing whether that line moved
 * or actually changed. Getting this wrong looks like a confident answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapAnchorLine,
  parseHunks,
} from "../server/core/review-inbox/line-map.mjs";

/** `diff --unified=0` output for the given hunk headers. */
const diff = (...headers) =>
  ["diff --git a/f b/f", "--- a/f", "+++ b/f", ...headers].join("\n");

test("8 lines inserted above shift the anchor without changing it", () => {
  const r = mapAnchorLine(diff("@@ -10,0 +11,8 @@"), 100);
  assert.equal(r.kind, "unchanged-mapped");
  assert.equal(r.currentLine, 108);
  assert.equal(r.offset, 8);
  assert.match(r.reasons[0], /moved by \+8/);
});

test("lines removed above shift the anchor the other way", () => {
  const r = mapAnchorLine(diff("@@ -10,3 +10,0 @@"), 100);
  assert.equal(r.kind, "unchanged-mapped");
  assert.equal(r.currentLine, 97);
  assert.equal(r.offset, -3);
});

test("a hunk containing the anchor reports a change, not a move", () => {
  const r = mapAnchorLine(diff("@@ -98,5 +98,6 @@"), 100);
  assert.equal(r.kind, "changed");
  assert.notEqual(r.kind, "unchanged-mapped");
});

test("a hunk that removes the anchor reports deletion", () => {
  const r = mapAnchorLine(diff("@@ -100,1 +99,0 @@"), 100);
  assert.equal(r.kind, "deleted");
  assert.equal(r.currentLine, null);
});

test("offsets from several hunks accumulate, and hunks below are ignored", () => {
  const r = mapAnchorLine(
    diff("@@ -5,0 +6,4 @@", "@@ -20,6 +25,2 @@", "@@ -150,0 +151,9 @@"),
    100,
  );
  assert.equal(r.kind, "unchanged-mapped");
  assert.equal(r.offset, 0, "+4 then -4 above; the hunk at 150 is below");
  assert.equal(r.currentLine, 100);
});

test("an untouched file maps the anchor to itself", () => {
  const r = mapAnchorLine("", 100);
  assert.equal(r.kind, "unchanged-mapped");
  assert.equal(r.currentLine, 100);
  assert.equal(r.offset, 0);
});

test("a rename is unmappable rather than guessed", () => {
  const r = mapAnchorLine(diff("@@ -10,0 +11,8 @@"), 100, { renamed: true });
  assert.equal(r.kind, "unmappable");
  assert.equal(r.currentLine, null);
});

test("a failed diff is unknown, never 'unchanged'", () => {
  const r = mapAnchorLine("", 100, { ok: false });
  assert.equal(r.kind, "unknown");
  assert.equal(r.currentLine, null);
  assert.match(r.reasons[0], /could not be read/);
});

test("a thread with no line anchor is unmappable", () => {
  assert.equal(mapAnchorLine("", null).kind, "unmappable");
  assert.equal(mapAnchorLine("", 0).kind, "unmappable");
});

test("hunk headers parse with and without explicit counts", () => {
  const hunks = parseHunks(diff("@@ -10 +11 @@", "@@ -20,3 +22,5 @@"));
  assert.deepEqual(hunks, [
    { oldStart: 10, oldLines: 1, newStart: 11, newLines: 1 },
    { oldStart: 20, oldLines: 3, newStart: 22, newLines: 5 },
  ]);
});

test("every outcome carries a reason a Why? panel can render", () => {
  const cases = [
    mapAnchorLine(diff("@@ -10,0 +11,8 @@"), 100),
    mapAnchorLine(diff("@@ -98,5 +98,6 @@"), 100),
    mapAnchorLine(diff("@@ -100,1 +99,0 @@"), 100),
    mapAnchorLine("", 100, { ok: false }),
    mapAnchorLine("", 100, { renamed: true }),
  ];
  for (const c of cases) {
    assert.ok(Array.isArray(c.reasons) && c.reasons.length > 0);
    assert.ok(c.reasons.every((r) => typeof r === "string" && r.length > 0));
  }
});
