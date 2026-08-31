// @ts-check
/**
 * Time-windowed cost/token aggregation: 7d/30d/all windows, per-model
 * input/output/cache splits, persistence round-trip, and retention bounds.
 * Run: node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OtelStore,
  normalizeTokenType,
} from "../server/core/otel/receiver.mjs";

const NOW = Date.parse("2026-08-31T12:00:00Z");
const DAY = 86400000;

function payload(metric, value, attrs, ts) {
  return {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: metric,
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    {
                      asDouble: value,
                      timeUnixNano: String(ts * 1e6),
                      attributes: Object.entries(attrs).map(([key, v]) => ({
                        key,
                        value: { stringValue: String(v) },
                      })),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function seed(store) {
  // today: opus input+output tokens + cost
  store.ingestMetrics(
    payload("claude_code.cost.usage", 1.5, { model: "opus" }, NOW),
  );
  store.ingestMetrics(
    payload(
      "claude_code.token.usage",
      1000,
      { model: "opus", type: "input" },
      NOW,
    ),
  );
  store.ingestMetrics(
    payload(
      "claude_code.token.usage",
      200,
      { model: "opus", type: "output" },
      NOW - 1000,
    ),
  );
  // 10 days ago: haiku cacheRead (inside 30d, outside 7d)
  store.ingestMetrics(
    payload(
      "claude_code.token.usage",
      5000,
      { model: "haiku", type: "cacheRead" },
      NOW - 10 * DAY,
    ),
  );
  store.ingestMetrics(
    payload("claude_code.cost.usage", 0.25, { model: "haiku" }, NOW - 10 * DAY),
  );
  // 40 days ago: sonnet cacheCreation (outside 30d, inside all)
  store.ingestMetrics(
    payload(
      "claude_code.token.usage",
      300,
      { model: "sonnet", type: "cache_creation" },
      NOW - 40 * DAY,
    ),
  );
}

test("windows split 7d / 30d / all by record day", () => {
  const store = new OtelStore({ now: () => NOW });
  seed(store);
  const w = store.windows();

  assert.equal(w.d7.models.length, 1, "7d sees only opus");
  assert.equal(w.d7.models[0].model, "opus");
  assert.equal(w.d7.models[0].input, 1000);
  assert.equal(w.d7.models[0].output, 200);
  assert.equal(w.d7.costUsd, 1.5);

  const d30models = w.d30.models.map((m) => m.model).sort();
  assert.deepEqual(d30models, ["haiku", "opus"], "30d adds haiku");
  const haiku = w.d30.models.find((m) => m.model === "haiku");
  assert.equal(haiku.cacheRead, 5000);
  assert.equal(w.d30.costUsd, 1.75);

  const allModels = w.all.models.map((m) => m.model).sort();
  assert.deepEqual(allModels, ["haiku", "opus", "sonnet"]);
  const sonnet = w.all.models.find((m) => m.model === "sonnet");
  assert.equal(sonnet.cacheCreation, 300, "cache_creation spelling normalizes");
});

test("models sort by cost then tokens; totals add up", () => {
  const store = new OtelStore({ now: () => NOW });
  seed(store);
  const all = store.windows().all;
  assert.equal(all.models[0].model, "opus", "highest cost first");
  assert.equal(all.tokens, 1000 + 200 + 5000 + 300);
});

test("summary() carries windows + retentionDays", () => {
  const store = new OtelStore({ now: () => NOW });
  seed(store);
  const s = store.summary();
  assert.equal(s.retentionDays, 90);
  assert.equal(s.windows.d7.models[0].model, "opus");
});

test("windows survive a persistence round-trip (tokenType persisted)", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawdeck-otel-"));
  try {
    const a = new OtelStore({ dir, now: () => NOW });
    seed(a);
    const b = new OtelStore({ dir, now: () => NOW });
    const w = b.windows();
    assert.equal(w.d7.models[0].input, 1000);
    assert.equal(
      w.d30.models.find((m) => m.model === "haiku")?.cacheRead,
      5000,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention bounds the all window on reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawdeck-otel-"));
  try {
    const a = new OtelStore({ dir, now: () => NOW, retentionDays: 20 });
    seed(a); // 40d-old sonnet record is written but beyond 20d retention
    const b = new OtelStore({ dir, now: () => NOW, retentionDays: 20 });
    const models = b.windows().all.models.map((m) => m.model);
    assert.ok(!models.includes("sonnet"), "stale day skipped on load");
    assert.ok(models.includes("haiku"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeTokenType tolerates spellings; unknown maps to other", () => {
  assert.equal(normalizeTokenType("input"), "input");
  assert.equal(normalizeTokenType("cacheRead"), "cacheRead");
  assert.equal(normalizeTokenType("cache_read"), "cacheRead");
  assert.equal(normalizeTokenType("cacheCreation"), "cacheCreation");
  assert.equal(normalizeTokenType("cache_creation"), "cacheCreation");
  assert.equal(normalizeTokenType("weird"), "other");
  assert.equal(normalizeTokenType(null), "other");
});
