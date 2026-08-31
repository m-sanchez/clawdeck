// @ts-check
/**
 * Dashboard-context builder: identity/path exclusions hold, the char budget
 * drops sections and reports them, output is deterministic. Run: node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDashContext } from "../server/lib/dash-context.mjs";

const SNAP = {
  checkout: { id: "repo-abc", branch: "main", dirtyCount: 3 },
  readiness: { ready: false, blockers: 2 },
  attention: [{ severity: "warn", title: "thing needs eyes" }],
  quotaPressure: {
    band: "green",
    fiveHourPct: 12,
    sevenDayPct: 4,
    stale: false,
  },
  cost: {
    rollup: {
      totalCostUsd: 1.2,
      byModel: { m: { costUsd: 1.2, sessions: 1 } },
      totalSubagents: 0,
    },
    burn: {
      perHourUsd: 0.5,
      fiveHour: {},
      sevenDay: {},
      projectedMonthUsd: null,
      coverageHours: 2,
      stale: false,
    },
  },
  findings: [{ ruleId: "X1", file: "src/a.ts", line: 3, tier: "warn" }],
  validation: { ok: false, report: [{ status: "fail", check: "tsc" }] },
  runs: [{ title: "fix tests", status: "running", phase: "work" }],
  sessions: {
    agents: [
      { active: true, branch: "main", latestSessionId: "s1" },
      { active: false, branch: "feat/x", latestSessionId: "s2" },
    ],
  },
  forge: {
    configured: true,
    provider: "github",
    mr: { iid: 5, state: "opened", title: "PR" },
    pipeline: { status: "success" },
  },
  delivery: { steps: [] },
  governor: { mode: "warn", warnings: [] },
  recentCommits: [
    {
      hash: "abc123",
      subject: "do things",
      author: "Someone Person",
      email: "sp@example.com",
    },
  ],
  worktrees: [
    { branch: "feat/x", cleanupClass: "safe", path: "C:/Users/someone/wt" },
  ],
  instructionBudget: { totalChars: 1000, totalEstTokens: 250 },
  // material that must never appear:
  authorBreakdown: [{ author: "Secret Author", email: "hidden@example.com" }],
  commitActivity: [{ day: "2026-01-01", author: "Secret Author" }],
  logSources: [{ path: "C:/Users/someone/.claude/logs/x.log" }],
  telemetry: {
    sessions: { s1: { cwd: "C:/Users/someone/private", model: "m" } },
  },
  panel: { pid: 123 },
  events: { sessions: [] },
  history: [{ t: 1 }],
};

test("hard exclusions never serialize", () => {
  const { context } = buildDashContext(SNAP);
  const text = JSON.stringify(context);
  assert.ok(!text.includes("authorBreakdown"));
  assert.ok(!text.includes("Secret Author"));
  assert.ok(!text.includes("hidden@example.com"));
  assert.ok(!text.includes("sp@example.com"));
  assert.ok(!text.includes("logSources"));
  assert.ok(!text.includes("C:/Users/someone"), "no cwd/path leakage");
  assert.ok(!text.includes('"pid"'));
});

test("inline + top-N sections present", () => {
  const { context } = buildDashContext(SNAP);
  assert.equal(context.checkout.branch, "main");
  assert.equal(context.commits[0].hash, "abc123");
  assert.equal(context.commits[0].author, undefined);
  assert.equal(context.sessions.active, 1);
  assert.equal(context.findings[0].ruleId, "X1");
  assert.equal(context.validation.failed[0].check, "tsc");
  assert.deepEqual(context.worktrees.cleanupCandidates, ["feat/x"]);
});

test("budget drops lowest-priority sections and reports them", () => {
  const { context, chars, dropped } = buildDashContext(SNAP, { maxChars: 400 });
  assert.ok(chars <= 400);
  assert.ok(dropped.length > 0);
  assert.ok(context.checkout, "highest-priority section survives");
});

test("deterministic for identical input", () => {
  const a = JSON.stringify(buildDashContext(SNAP).context);
  const b = JSON.stringify(buildDashContext(SNAP).context);
  assert.equal(a, b);
});
