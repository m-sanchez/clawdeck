// @ts-check
/** Unit tests for the read-only endpoint path/ref validators. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeRelativeFile, isSafeRef } from "../server/lib/validate.mjs";

test("isSafeRelativeFile accepts repo-relative paths", () => {
  assert.equal(isSafeRelativeFile("src/app.ts"), true);
  assert.equal(isSafeRelativeFile(".claude/commands/panel.md"), true);
  assert.equal(isSafeRelativeFile("a file with spaces.md"), true);
});

test("isSafeRelativeFile rejects traversal, absolute, drive-letter, empty", () => {
  assert.equal(isSafeRelativeFile(""), false);
  assert.equal(isSafeRelativeFile(null), false);
  assert.equal(isSafeRelativeFile("../etc/passwd"), false);
  assert.equal(isSafeRelativeFile("a/../../b"), false);
  assert.equal(isSafeRelativeFile("/etc/passwd"), false);
  assert.equal(isSafeRelativeFile("\\windows\\system32"), false);
  assert.equal(isSafeRelativeFile("C:/Windows/win.ini"), false);
});

test("isSafeRef accepts ordinary branch/ref names", () => {
  assert.equal(isSafeRef("develop"), true);
  assert.equal(isSafeRef("origin/develop"), true);
  assert.equal(isSafeRef("feat/upbeat-lovelace-d06615"), true);
  assert.equal(isSafeRef("v1.2.3"), true);
});

test("isSafeRef rejects traversal, spaces, shell metachars, empty", () => {
  assert.equal(isSafeRef(""), false);
  assert.equal(isSafeRef("a..b"), false);
  assert.equal(isSafeRef("bad branch"), false);
  assert.equal(isSafeRef("a;rm -rf"), false);
  assert.equal(isSafeRef("$(whoami)"), false);
  assert.equal(isSafeRef("a&&b"), false);
});
