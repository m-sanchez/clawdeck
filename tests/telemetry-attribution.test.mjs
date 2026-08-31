// @ts-check
/**
 * T3/T4 regression tests: subagent-model attribution uses the ACTUAL agent
 * model (from the event, else the pinned agent config), never the parent as a
 * proxy; and the OTEL layer persists attributed records that survive a restart
 * with bounded retention.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectWaste } from "../server/core/telemetry/detectors.mjs";
import { applyEvent } from "../server/core/events/projection.mjs";
import { OtelStore } from "../server/core/otel/receiver.mjs";

// ── T3: subagent model attribution ──

const fableSession = { s1: { model: "fable", costUsd: 5 } };

function eventWith(agentModels, agentTypes) {
  return {
    sessions: [
      {
        sessionId: "s1",
        subagentStarts: Object.values(agentTypes).reduce((a, b) => a + b, 0),
        agentTypes,
        agentModels,
        compactions: 0,
      },
    ],
  };
}

test("T3: a Sonnet Explore under a Fable parent does NOT flag reader-on-fable", () => {
  const events = eventWith({ Explore: "sonnet" }, { Explore: 2 });
  const f = detectWaste({ live: fableSession }, events);
  assert.ok(
    !f.some((x) => x.type === "reader-on-fable"),
    "the reader ran on Sonnet; no Fable warning",
  );
});

test("T3: a Fable Explore under a Fable parent DOES flag reader-on-fable", () => {
  const events = eventWith({ Explore: "fable" }, { Explore: 2 });
  const f = detectWaste({ live: fableSession }, events);
  const hit = f.find((x) => x.type === "reader-on-fable");
  assert.ok(hit, "the reader actually ran on Fable");
  assert.match(hit.measurement, /actual|subagent model/i);
});

test("T3: an UNKNOWN subagent model is not inferred from the Fable parent", () => {
  const events = eventWith({}, { Explore: 2 }); // no per-agent model
  const f = detectWaste({ live: fableSession }, events);
  assert.ok(
    !f.some((x) => x.type === "reader-on-fable"),
    "unknown model must not be assumed to be the parent's Fable",
  );
});

test("T3: a pinned agent config resolves the model when the event lacks it", () => {
  const events = eventWith({}, { "verification-auditor": 1 });
  // verification-auditor is pinned to opus -> not fable -> no warning
  const opusPin = detectWaste({ live: fableSession }, events, {
    agentModelPins: { "verification-auditor": "opus" },
  });
  assert.ok(!opusPin.some((x) => x.type === "reader-on-fable"));
  // a hypothetical fable-pinned reader -> warning
  const fablePin = detectWaste(
    { live: fableSession },
    eventWith({}, { "plan-critic": 1 }),
    { agentModelPins: { "plan-critic": "fable" } },
  );
  assert.ok(fablePin.some((x) => x.type === "reader-on-fable"));
});

test("T3: projection records per-agent-type model from subagent.start", () => {
  const sessions = new Map();
  applyEvent(sessions, {
    v: 1,
    id: "e1",
    ts: 1000,
    event: "subagent.start",
    session_id: "s1",
    agent_type: "Explore",
    agent_id: "a1",
    data: { model: "sonnet" },
  });
  const s = sessions.get("s1");
  assert.equal(s.agentModels.Explore, "sonnet");
});

// ── T4: persistent, attributed OTEL ──

const otlp = (points) => ({
  resourceMetrics: [
    {
      scopeMetrics: [
        {
          metrics: [
            { name: "claude_code.cost.usage", sum: { dataPoints: points } },
          ],
        },
      ],
    },
  ],
});
const attr = (o) =>
  Object.entries(o).map(([k, v]) => ({
    key: k,
    value: { stringValue: String(v) },
  }));

test("T4: OTEL records persist across a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-"));
  const s1 = new OtelStore({ dir, now: () => 1000 });
  s1.ingestMetrics(
    otlp([
      {
        asDouble: 0.4,
        attributes: attr({ model: "fable", agent_type: "Explore" }),
      },
    ]),
  );
  // "restart": a fresh store over the same dir reloads history.
  const s2 = new OtelStore({ dir, now: () => 2000 });
  const sum = s2.summary();
  assert.equal(sum.enabled, true);
  assert.equal(sum.totalCostUsd, 0.4);
  assert.equal(sum.byModel.fable.costUsd, 0.4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T4: attribution dims (agent.name, query_source) — Claude Code's real keys — are retained", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-"));
  const s = new OtelStore({ dir, now: () => 1000 });
  s.ingestMetrics(
    otlp([
      {
        asDouble: 0.1,
        attributes: attr({
          model: "sonnet",
          "agent.name": "Explore",
          query_source: "subagent",
        }),
      },
    ]),
  );
  const sum = s.summary();
  assert.ok(sum.byAgentType.Explore.costUsd >= 0.1, "agent.name retained");
  assert.ok(sum.byQuerySource.subagent.costUsd >= 0.1, "query_source retained");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T4: a stable metric id is not double-counted across duplicate deliveries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-"));
  const s = new OtelStore({ dir, now: () => 1000 });
  const dup = otlp([
    { asDouble: 0.3, attributes: attr({ model: "fable", "metric.id": "abc" }) },
  ]);
  s.ingestMetrics(dup);
  s.ingestMetrics(dup); // same stable id
  assert.equal(s.summary().totalCostUsd, 0.3, "deduped by stable id");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T4: retention rotates out day files older than the window", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-"));
  const DAY = 86400000;
  const s = new OtelStore({ dir, retentionDays: 3, now: () => 100 * DAY });
  // Hand-plant an old day file that retention should drop.
  const otelDir = path.join(dir);
  fs.writeFileSync(
    path.join(otelDir, "otel-1970-01-10.ndjson"),
    JSON.stringify({ ts: 10 * DAY, model: "old", metric: "cost", value: 9 }) +
      "\n",
  );
  s.rotate();
  assert.ok(
    !fs.existsSync(path.join(otelDir, "otel-1970-01-10.ndjson")),
    "old day file removed by retention",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T4: no dir -> in-memory only (back-compat)", () => {
  const s = new OtelStore();
  s.ingestMetrics(
    otlp([{ asDouble: 0.5, attributes: attr({ model: "opus" }) }]),
  );
  assert.equal(s.summary().totalCostUsd, 0.5);
});
