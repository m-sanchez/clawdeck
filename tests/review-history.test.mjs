// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendReviewHistory,
  getReviewHistory,
} from "../server/adapters/reviews.mjs";

test("review history: appends, caps at 20, keeps newest last", () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-revhist-"));
  for (let i = 0; i < 25; i++)
    appendReviewHistory(dir, {
      at: `t${i}`,
      blockCount: i % 3,
      warnCount: i,
      total: i,
    });
  const h = getReviewHistory(dir);
  assert.equal(h.length, 20);
  assert.equal(h.at(-1).at, "t24");
  assert.equal(h[0].at, "t5");
});

test("review history: empty when no file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-revhist-empty-"));
  assert.deepEqual(getReviewHistory(dir), []);
});
