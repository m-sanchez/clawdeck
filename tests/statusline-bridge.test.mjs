// @ts-check
/** Unit tests for the statusline bridge's pure helpers. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import bridge from "../hooks/statusline-bridge.cjs";

const { normalize, statusLine, shapeOf } = bridge;

const SAMPLE = {
  session_id: "abc123",
  model: { id: "claude-opus-4-8", display_name: "Opus" },
  effort: { level: "high" },
  workspace: { current_dir: "/repo/wt", git_worktree: "feature-x" },
  cost: { total_cost_usd: 0.0123, total_duration_ms: 45000 },
  context_window: {
    used_percentage: 8.5,
    context_window_size: 200000,
    total_input_tokens: 15500,
    total_output_tokens: 1200,
    current_usage: {
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 5000,
    },
  },
  exceeds_200k_tokens: false,
  rate_limits: {
    five_hour: { used_percentage: 23.5 },
    seven_day: { used_percentage: 41.2 },
  },
};

test("normalize maps the documented statusline payload", () => {
  const r = normalize(SAMPLE, 9999);
  assert.equal(r.sessionId, "abc123");
  assert.equal(r.model, "Opus");
  assert.equal(r.modelId, "claude-opus-4-8");
  assert.equal(r.effort, "high");
  assert.equal(r.worktree, "feature-x");
  assert.equal(r.costUsd, 0.0123);
  assert.equal(r.ctxPct, 8.5);
  assert.equal(r.tokensIn, 15500);
  assert.equal(r.cacheRead, 2000);
  assert.equal(r.cacheCreate, 5000);
  assert.equal(r.rateLimits.fiveHourPct, 23.5);
  assert.equal(r.ts, 9999);
});

test("normalize is defensive: empty/garbage input yields nulls, never throws", () => {
  const r = normalize({}, 1);
  assert.equal(r.sessionId, null);
  assert.equal(r.model, null);
  assert.equal(r.costUsd, null);
  assert.equal(r.ctxPct, null);
  assert.equal(r.rateLimits.fiveHourPct, null);
  assert.doesNotThrow(() => normalize(undefined, 1));
  assert.doesNotThrow(() => normalize({ model: "oops" }, 1));
});

test("statusLine is compact and omits missing segments", () => {
  assert.equal(
    statusLine(normalize(SAMPLE, 1)),
    "Opus (feature-x) · ctx 9% · $0.01 · high",
  );
  assert.equal(statusLine(normalize({}, 1)), "…");
  assert.equal(
    statusLine({ model: "Sonnet", ctxPct: null, costUsd: null }),
    "Sonnet",
  );
});

test("shapeOf redacts values to their types", () => {
  assert.deepEqual(shapeOf({ a: 1, b: "x", c: { d: true } }), {
    a: "number",
    b: "string",
    c: { d: "boolean" },
  });
  assert.deepEqual(shapeOf({ list: [{ n: 1 }] }), { list: [{ n: "number" }] });
});
