// @ts-check
/**
 * Drift guard: the runtime snapshot's top-level keys must match the documented
 * contract (contracts/panel-protocol.ts PanelSnapshot). If the builder adds or
 * removes a key, this fails until both the contract and this list are updated.
 * Run: node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot } from "../server/lib/snapshot.mjs";
import { PerfMetrics } from "../server/core/telemetry/perf.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const checkoutRoot = path.resolve(testDir, "..", "..", ".."); // worktree root

const EXPECTED = [
  "checkout",
  "runs",
  "worktrees",
  "validation",
  "reviews",
  "findings",
  "attention",
  "jobs",
  "sessions",
  "telemetry",
  "events",
  "policy",
  "cost",
  "governor",
  "quotaPressure",
  "remoteBranches",
  "recentCommits",
  "commitActivity",
  "authorBreakdown",
  "reviewHistory",
  "readiness",
  "logSources",
  "setup",
  "instructionBudget",
  "history",
  "panel",
  "forge",
  "reviewInbox",
  "attentionInbox",
  "ci",
  "decisions",
  "deliveryReadiness",
  "tasks",
  "delivery",
  "perf",
  "clawd",
  "sections",
  "emittedAt",
].sort();

test("snapshot top-level keys match the PanelSnapshot contract", async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-"));
  const ctx = {
    checkoutId: "test",
    checkoutRoot,
    repoRoot: checkoutRoot,
    runtimeDir,
    panelRoot: path.join(checkoutRoot, ".claude", "panel"),
  };
  const snap = await buildSnapshot(ctx, {
    reviews: { status: "pending", findings: [], blockCount: 0, warnCount: 0 },
    validation: { status: "none", checks: [], passed: false, ranAt: null },
    perf: new PerfMetrics(),
  });
  assert.deepEqual(Object.keys(snap).sort(), EXPECTED);
});
