// @ts-check
/** Dirty-section render gate: fail-open on missing data, precise otherwise. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSections, needsRender } from "../ui/lib/dirty.mjs";

const PREV = { cost: "aa", runs: "bb", reviews: "cc" };

test("diffSections reports changed, added and removed keys", () => {
  const changed = diffSections(PREV, { cost: "aa", runs: "b2", extra: "dd" });
  assert.deepEqual([...changed].sort(), ["extra", "reviews", "runs"]);
});

test("diffSections is null (unknown) without both hash maps", () => {
  assert.equal(diffSections(null, PREV), null);
  assert.equal(diffSections(PREV, null), null);
});

test("needsRender fails open on missing deps or hashes", () => {
  assert.equal(needsRender(null, new Set(), PREV), true);
  assert.equal(needsRender(["cost"], null, PREV), true);
  assert.equal(needsRender(["cost"], new Set(), null), true);
});

test("needsRender skips only when every dep is hashed and unchanged", () => {
  assert.equal(needsRender(["cost", "runs"], new Set(), PREV), false);
  assert.equal(needsRender(["cost"], new Set(["cost"]), PREV), true);
  // A dep the server does not hash (panel, perf) always renders.
  assert.equal(needsRender(["cost", "panel"], new Set(), PREV), true);
});
