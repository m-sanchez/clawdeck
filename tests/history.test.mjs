// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordSample,
  getHistory,
  resetHistory,
} from "../server/lib/history.mjs";

test("history: throttles samples closer than 15s, keeps spaced ones", () => {
  resetHistory();
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const at = (ms) => new Date(base + ms).toISOString();
  recordSample({ t: at(0), activeAgents: 1 });
  const len = getHistory().length;
  recordSample({ t: at(5000), activeAgents: 2 }); // < 15s -> dropped
  assert.equal(getHistory().length, len);
  recordSample({ t: at(16000), activeAgents: 3 }); // >= 15s -> kept
  assert.equal(getHistory().length, len + 1);
  assert.equal(getHistory().at(-1).activeAgents, 3);
});

test("history: bounded ring buffer never exceeds the cap", () => {
  resetHistory();
  const base = Date.parse("2026-02-01T00:00:00.000Z");
  for (let i = 0; i < 300; i++)
    recordSample({
      t: new Date(base + i * 16000).toISOString(),
      activeAgents: i % 4,
    });
  const h = getHistory();
  assert.ok(h.length <= 240, `expected <= 240, got ${h.length}`);
  // Negatives are clamped to 0.
  recordSample({
    t: new Date(base + 9_000_000).toISOString(),
    activeAgents: -5,
  });
  assert.equal(getHistory().at(-1).activeAgents, 0);
});
