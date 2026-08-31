// @ts-check
/** Unit tests for cost rollups + avoidable-spend detectors. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rollupCost } from "../server/core/telemetry/rollup.mjs";
import { detectWaste } from "../server/core/telemetry/detectors.mjs";

// `live` is the contract the rollup reads (stale sessions must not inflate the
// live number); the adapter always supplies it.
const telemetry = {
  live: {
    s1: { model: "Opus", costUsd: 1 },
    s2: { model: "Fable", costUsd: 2 },
  },
};
const events = {
  sessions: [
    {
      sessionId: "s1",
      subagentStarts: 3,
      agentTypes: { Explore: 2, "verification-auditor": 1 },
      agentModels: { Explore: "opus", "verification-auditor": "opus" },
      compactions: 1,
    },
    {
      sessionId: "s2",
      subagentStarts: 15,
      agentTypes: { Explore: 15 },
      // The readers actually ran on Fable (attributed from the event), which is
      // what makes reader-on-fable a truthful finding for this session.
      agentModels: { Explore: "fable" },
      compactions: 0,
    },
  ],
};

test("rollupCost aggregates by model, agent type, and Fable share", () => {
  const r = rollupCost(telemetry, events);
  assert.equal(r.totalCostUsd, 3);
  assert.equal(r.byModel.Opus.costUsd, 1);
  assert.equal(r.byModel.Fable.costUsd, 2);
  assert.equal(r.fable.costUsd, 2);
  assert.ok(Math.abs(r.fable.share - 2 / 3) < 1e-4);
  assert.equal(r.byAgentType.Explore, 17);
  assert.equal(r.totalSubagents, 18);
  assert.equal(r.totalCompactions, 1);
});

test("detectWaste flags readers-on-Fable and high fan-out, not Opus readers", () => {
  const f = detectWaste(telemetry, events);
  assert.ok(
    f.some((x) => x.type === "reader-on-fable" && x.sessionId === "s2"),
    "Fable session with Explore subagents should flag",
  );
  assert.ok(
    f.some((x) => x.type === "high-fanout" && x.sessionId === "s2"),
    "15 subagents should flag high fan-out",
  );
  assert.ok(
    !f.some((x) => x.type === "reader-on-fable" && x.sessionId === "s1"),
    "an Opus session must not flag reader-on-fable",
  );
  // Every finding carries a measurement.
  assert.ok(f.every((x) => typeof x.measurement === "string" && x.measurement));
});

test("empty inputs produce a zeroed rollup and no findings", () => {
  const r = rollupCost({}, {});
  assert.equal(r.totalCostUsd, 0);
  assert.equal(r.fable.share, 0);
  assert.deepEqual(detectWaste({}, {}), []);
});
