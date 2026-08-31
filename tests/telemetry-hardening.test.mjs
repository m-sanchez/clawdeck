// @ts-check
/**
 * Wave 2 Round-1 hardening (Auditor D). Regression tests for:
 *  - OTEL nanosecond timestamps (real OTLP) must persist + survive restart
 *  - OTEL reads Claude Code's REAL attribute keys (agent.name, query_source)
 *  - OTEL cumulative temporality is not summed as if it were delta
 *  - Governor perLoopSoftUsd:0 must not gate a $0 / non-Fable loop
 *  - live freshness rejects a future-dated (negative-age) sample
 *  - rollup/detectors never fall back to all sessions when live is absent
 *  - agent-md model pin with a trailing # comment is parsed cleanly
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OtelStore } from "../server/core/otel/receiver.mjs";
import { evaluateLoopBoundary } from "../server/core/telemetry/governor.mjs";
import { rollupCost } from "../server/core/telemetry/rollup.mjs";
import { detectWaste } from "../server/core/telemetry/detectors.mjs";
import { getLiveTelemetry } from "../server/adapters/telemetry-live.mjs";

const NS_2026 = "1783512000000000000"; // realistic OTLP timeUnixNano (ns)
// Same instant in ms. Stores that load history MUST run on this fixed clock, or
// the real one ages the fixture out of the retention window and the test rots.
const MS_2026 = 1783512000000;
const otlp = (points, name = "claude_code.cost.usage") => ({
  resourceMetrics: [
    { scopeMetrics: [{ metrics: [{ name, sum: { dataPoints: points } }] }] },
  ],
});
const attr = (o) =>
  Object.entries(o).map(([k, v]) => ({
    key: k,
    value: { stringValue: String(v) },
  }));

test("OTEL-TS-NANOSECONDS: a real ns timestamp persists and survives restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otelns-"));
  const s1 = new OtelStore({ dir, now: () => MS_2026 });
  s1.ingestMetrics(
    otlp([
      {
        asDouble: 0.42,
        timeUnixNano: NS_2026,
        attributes: attr({ model: "fable" }),
      },
    ]),
  );
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
  assert.ok(files.length >= 1, "a day file must be written for a ns timestamp");
  const s2 = new OtelStore({ dir, now: () => MS_2026 });
  assert.equal(s2.summary().totalCostUsd, 0.42, "history survives restart");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("OTEL-ATTR-KEYS: real Claude Code attribute keys resolve attribution", () => {
  const s = new OtelStore();
  s.ingestMetrics(
    otlp([
      {
        asDouble: 0.1,
        timeUnixNano: NS_2026,
        attributes: attr({
          model: "sonnet",
          "agent.name": "Explore",
          query_source: "subagent",
        }),
      },
    ]),
  );
  const sum = s.summary();
  assert.ok(
    sum.byAgentType.Explore,
    "agent.name maps to the agent-type bucket",
  );
  assert.ok(sum.byAgentType.Explore.costUsd >= 0.1);
});

test("OTEL cumulative temporality is delta-ized, not summed", () => {
  const s = new OtelStore();
  const cumulative = (v) => ({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.cost.usage",
                sum: {
                  aggregationTemporality: 2, // AGGREGATION_TEMPORALITY_CUMULATIVE
                  dataPoints: [
                    {
                      asDouble: v,
                      timeUnixNano: NS_2026,
                      attributes: attr({
                        model: "fable",
                        "session.id": "sess1",
                      }),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
  s.ingestMetrics(cumulative(0.1));
  s.ingestMetrics(cumulative(0.3));
  s.ingestMetrics(cumulative(0.6)); // running total; true spend is 0.6
  assert.ok(
    Math.abs(s.summary().totalCostUsd - 0.6) < 1e-6,
    "cumulative snapshots must not be summed to 1.0",
  );
});

test("OTEL-CUM-MULTISERIES: concurrent cumulative series under one model/session are not conflated", () => {
  const s = new OtelStore();
  const cum = (v, qs) => ({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.cost.usage",
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    {
                      asDouble: v,
                      timeUnixNano: NS_2026,
                      attributes: attr({
                        model: "fable",
                        "session.id": "sess1",
                        query_source: qs,
                      }),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
  // Two independent running totals differing ONLY in query_source, interleaved.
  s.ingestMetrics(cum(0.5, "user"));
  s.ingestMetrics(cum(0.3, "subagent"));
  s.ingestMetrics(cum(0.8, "user")); // user series now 0.8
  s.ingestMetrics(cum(0.5, "subagent")); // subagent series now 0.5
  const sum = s.summary();
  assert.ok(Math.abs(sum.totalCostUsd - 1.3) < 1e-6, "true total 0.8+0.5=1.3");
  assert.ok(Math.abs(sum.byQuerySource.user.costUsd - 0.8) < 1e-6);
  assert.ok(Math.abs(sum.byQuerySource.subagent.costUsd - 0.5) < 1e-6);
});

test("OTEL-DELTA-DEDUP: a retried delta batch (no id) is not double-counted", () => {
  const s = new OtelStore();
  const delta = () => ({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.cost.usage",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    {
                      asDouble: 0.2,
                      timeUnixNano: NS_2026,
                      attributes: attr({ model: "fable", "session.id": "s1" }),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
  s.ingestMetrics(delta());
  s.ingestMetrics(delta()); // exact retry of the same batch
  assert.ok(Math.abs(s.summary().totalCostUsd - 0.2) < 1e-6, "retry deduped");
});

test("GOV-ZERO-BUDGET: perLoopSoftUsd:0 does not gate a $0 / non-Fable loop", () => {
  const d = evaluateLoopBoundary({
    costStartUsd: 5,
    costNowUsd: 40,
    model: "opus",
    policy: { mode: "enforce", perLoopSoftUsd: 0 },
  });
  assert.equal(
    d.gate,
    false,
    "a zero budget must not gate a non-Fable / $0 loop",
  );
});

test("LIVE-FUTURE-TS: a future-dated sample is not counted as live", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltf-"));
  const sdir = path.join(dir, ".claude", ".runtime", "telemetry", "sessions");
  fs.mkdirSync(sdir, { recursive: true });
  const now = 1_000_000_000;
  fs.writeFileSync(
    path.join(sdir, "future.json"),
    JSON.stringify({ sessionId: "future", costUsd: 999, ts: now + 3_600_000 }),
  );
  const out = getLiveTelemetry({ checkoutRoot: dir }, [], now);
  assert.equal(out.liveCount, 0, "future sample excluded from live");
  assert.equal(out.sumLiveCostUsd, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ROLLUP-STALE-FALLBACK: rollup/detectors do not sum all sessions when live is absent", () => {
  const telemetry = {
    sessions: { fresh: { costUsd: 1 }, stale: { costUsd: 500 } },
  };
  // No `live` key -> must NOT fall back to summing every session.
  assert.equal(rollupCost(telemetry, { sessions: [] }).totalCostUsd, 0);
  assert.deepEqual(detectWaste(telemetry, { sessions: [] }), []);
});
