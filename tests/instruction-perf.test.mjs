// @ts-check
/**
 * Phase J (instruction-budget truth) + Phase L (panel perf metrics).
 * J: the always-loaded set is real files with clearly-labelled estimates, and
 *    on-demand material is not counted as baseline; nothing claims a tokenizer
 *    count.
 * L: PerfMetrics computes real p50/p95 over a bounded window and tracks
 *    ingest/backlog counters for the Health view.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getInstructionBudget } from "../server/adapters/instruction-budget.mjs";
import { PerfMetrics } from "../server/core/telemetry/perf.mjs";

// Synthetic checkout: a root CLAUDE.md + AGENTS.md, one unconditional rule and
// one path-scoped rule, so the budget split is asserted against known files.
let CHECKOUT;
before(() => {
  CHECKOUT = mkdtempSync(path.join(tmpdir(), "clawdeck-budget-"));
  writeFileSync(path.join(CHECKOUT, "CLAUDE.md"), "# project instructions\n");
  writeFileSync(path.join(CHECKOUT, "AGENTS.md"), "# agents manual\n");
  const rules = path.join(CHECKOUT, ".claude", "rules");
  mkdirSync(rules, { recursive: true });
  writeFileSync(path.join(rules, "style.md"), "# style\nalways loaded\n");
  writeFileSync(
    path.join(rules, "scoped.md"),
    "---\npaths:\n  - src/**\n---\n# scoped\n",
  );
});
after(() => rmSync(CHECKOUT, { recursive: true, force: true }));

// ── J ──

test("J: instruction budget reports the real always-loaded set as an estimate", () => {
  const b = getInstructionBudget({ checkoutRoot: CHECKOUT });
  assert.equal(b.estimated, true);
  assert.match(b.note, /estimate|not a tokenizer/i);
  // CLAUDE.md exists in this checkout and is always-loaded.
  const claude = b.alwaysLoaded.find((e) => e.path === "CLAUDE.md");
  assert.ok(claude, "CLAUDE.md is in the always-loaded set");
  assert.ok(claude.chars > 0 && claude.estTokens > 0);
  assert.equal(
    b.totalChars,
    b.alwaysLoaded.reduce((n, e) => n + e.chars, 0),
  );
});

test("OL-2: baseline = CLAUDE.md + unconditional rules; AGENTS.md is on-demand", () => {
  const b = getInstructionBudget({ checkoutRoot: CHECKOUT });
  assert.ok(
    !b.alwaysLoaded.some((e) => e.path === "AGENTS.md"),
    "AGENTS.md must not be in the baseline",
  );
  assert.ok(
    b.onDemand.some((d) => d.path === "AGENTS.md"),
    "AGENTS.md must be listed as on-demand",
  );
  const baselinePaths = b.alwaysLoaded.map((e) => e.path);
  assert.ok(baselinePaths.includes("CLAUDE.md"), "root CLAUDE.md is baseline");
  assert.ok(
    baselinePaths.some((p) => /^\.claude\/rules\/.*\.md$/.test(p)),
    "unconditional rules (no paths frontmatter) are part of the baseline",
  );
});

test("J: path-scoped rules are on-demand, not counted in the baseline total", () => {
  const b = getInstructionBudget({ checkoutRoot: CHECKOUT });
  const pathScoped = b.onDemand.find(
    (d) => d.path === ".claude/rules (path-scoped)",
  );
  assert.ok(pathScoped, "path-scoped rules are reported as on-demand");
  // The baseline total is exactly the always-loaded chars, never on-demand dirs.
  assert.notEqual(b.totalChars, 0);
  assert.equal(
    b.totalChars,
    b.alwaysLoaded.reduce((n, e) => n + e.chars, 0),
  );
  assert.equal(b.totalEstTokens, Math.round(b.totalChars / 4));
});

// ── L ──

test("L: PerfMetrics computes p50/p95 and finds the slowest adapter", () => {
  const m = new PerfMetrics(50);
  for (const v of [10, 20, 30, 40, 100]) m.recordSnapshot(v);
  const s = m.summary({ sseClients: 2 });
  assert.equal(s.snapshot.p50, 30);
  assert.equal(s.snapshot.p95, 100);
  assert.equal(s.sseClients, 2);

  m.recordAdapter("gitlab", 500);
  m.recordAdapter("gitlab", 400);
  m.recordAdapter("checkout", 5);
  const s2 = m.summary();
  assert.equal(s2.slowestAdapter.name, "gitlab");
});

test("L: ingest + drop counters accumulate", () => {
  const m = new PerfMetrics();
  m.recordIngest(true);
  m.recordIngest(false);
  m.recordIngest(true);
  m.recordDropped(2);
  const s = m.summary();
  assert.equal(s.ingest.ok, 2);
  assert.equal(s.ingest.failed, 1);
  assert.equal(s.eventsDropped, 2);
});

test("L: the sample ring is bounded", () => {
  const m = new PerfMetrics(10);
  for (let i = 0; i < 100; i++) m.recordSnapshot(i);
  assert.ok(m.snapshotMs.length <= 10);
});
