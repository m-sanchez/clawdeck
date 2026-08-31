// @ts-check
/** Unit tests for session liveness (mtime floor + live-sample signal). node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentIsActive } from "../server/adapters/sessions.mjs";

const NOW = 1_000_000;
const min = (m) => m * 60 * 1000;

test("fresh transcript mtime alone is active", () => {
  assert.equal(
    agentIsActive({ lastMs: NOW - min(1), sampleAgeMs: null, now: NOW }),
    true,
  );
});

test("stale mtime but fresh live sample is active", () => {
  assert.equal(
    agentIsActive({ lastMs: NOW - min(30), sampleAgeMs: min(1), now: NOW }),
    true,
  );
});

test("fresh sample with no transcript at all is active", () => {
  assert.equal(
    agentIsActive({ lastMs: 0, sampleAgeMs: min(1), now: NOW }),
    true,
  );
});

test("a stale sample never marks a mtime-fresh session dead", () => {
  // mtime fresh, sample old -> still active (no false-dead regression).
  assert.equal(
    agentIsActive({ lastMs: NOW - min(2), sampleAgeMs: min(30), now: NOW }),
    true,
  );
});

test("both signals stale (or absent) is inactive", () => {
  assert.equal(
    agentIsActive({ lastMs: NOW - min(30), sampleAgeMs: min(30), now: NOW }),
    false,
  );
  assert.equal(
    agentIsActive({ lastMs: NOW - min(30), sampleAgeMs: null, now: NOW }),
    false,
  );
});
