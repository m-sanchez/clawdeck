// @ts-check
/** Unit tests for the findings id + lifecycle model. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findingId,
  canTransition,
  nextStates,
  FINDING_STATES,
} from "../server/core/findings/model.mjs";

test("findingId is deterministic and identity-based", () => {
  const a = {
    file: "src/x.ts",
    line: 12,
    ruleId: "LOG001",
    title: "console.log",
  };
  assert.equal(findingId(a), findingId({ ...a })); // same identity -> same id
  assert.notEqual(findingId(a), findingId({ ...a, line: 13 })); // different line
  assert.notEqual(findingId(a), findingId({ ...a, file: "src/y.ts" }));
  assert.match(findingId(a), /^f_/);
});

test("findingId is title-normalized (case/whitespace insensitive)", () => {
  const a = { file: "x", line: 1, ruleId: "R", title: "Bad Thing" };
  assert.equal(findingId(a), findingId({ ...a, title: "  bad thing  " }));
});

test("lifecycle transitions are constrained", () => {
  assert.ok(canTransition("found", "confirmed"));
  assert.ok(canTransition("found", "rejected"));
  assert.ok(!canTransition("found", "resolved")); // cannot skip straight to resolved
  assert.ok(canTransition("confirmed", "fix-dispatched"));
  // resolved requires verification: changed -> targeted-test-passed -> resolved
  assert.ok(!canTransition("changed", "resolved"));
  assert.ok(canTransition("changed", "targeted-test-passed"));
  assert.ok(canTransition("targeted-test-passed", "resolved"));
  assert.deepEqual(nextStates("resolved"), ["reverify-required"]); // reopen only
  assert.ok(FINDING_STATES.includes("fix-dispatched"));
});
