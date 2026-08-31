// @ts-check
// Session records rotate like every other telemetry store.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pruneSessionRecords,
  SESSION_RETENTION_MS,
} from "../server/adapters/telemetry-live.mjs";

const NOW = 1_800_000_000_000;

function rootWith(records) {
  const root = mkdtempSync(join(tmpdir(), "sessretention-"));
  const dir = join(root, ".claude", ".runtime", "telemetry", "sessions");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(records))
    writeFileSync(join(dir, name), body);
  return { root, dir };
}

const listed = (dir) => readdirSync(dir).sort();

test("records past the window go, fresh ones stay", () => {
  const { root, dir } = rootWith({
    "old.json": JSON.stringify({ ts: NOW - SESSION_RETENTION_MS - 1 }),
    "fresh.json": JSON.stringify({ ts: NOW - 1000 }),
    "edge.json": JSON.stringify({ ts: NOW - SESSION_RETENTION_MS }),
  });
  try {
    const { removed } = pruneSessionRecords([root], NOW);
    assert.equal(removed, 1);
    assert.deepEqual(listed(dir), ["edge.json", "fresh.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record of unknown age is kept, never deleted on a guess", () => {
  const { root, dir } = rootWith({
    "nots.json": JSON.stringify({ costUsd: 1 }),
    "broken.json": "{ not json",
  });
  try {
    assert.equal(pruneSessionRecords([root], NOW).removed, 0);
    assert.deepEqual(listed(dir), ["broken.json", "nots.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing telemetry directory is not an error", () => {
  const root = mkdtempSync(join(tmpdir(), "sessretention-empty-"));
  try {
    assert.equal(pruneSessionRecords([root, null, ""], NOW).removed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the window is configurable for callers that need a different one", () => {
  const { root, dir } = rootWith({
    "a.json": JSON.stringify({ ts: NOW - 5000 }),
  });
  try {
    assert.equal(pruneSessionRecords([root], NOW, { maxAgeMs: 1000 }).removed, 1);
    assert.deepEqual(listed(dir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
