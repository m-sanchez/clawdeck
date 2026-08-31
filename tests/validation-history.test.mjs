// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendValidationHistory,
  getValidationHistory,
} from "../server/adapters/validation.mjs";

test("validation history: appends, caps at 20, keeps newest last", () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-valhist-"));
  for (let i = 0; i < 25; i++)
    appendValidationHistory(dir, "current", {
      ranAt: `t${i}`,
      ok: i % 2 === 0,
      passed: i,
      failed: 0,
      total: i,
    });
  const h = getValidationHistory(dir, "current");
  assert.equal(h.length, 20);
  assert.equal(h.at(-1).ranAt, "t24");
  assert.equal(h[0].ranAt, "t5"); // oldest survivor after the cap
});

test("validation history: empty when no file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-valhist-empty-"));
  assert.deepEqual(getValidationHistory(dir, "current"), []);
});
