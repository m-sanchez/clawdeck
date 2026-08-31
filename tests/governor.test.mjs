// @ts-check
/** Unit tests for the Fable Governor. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateGovernor,
  shouldGateNextIteration,
  readFablePolicy,
} from "../server/core/telemetry/governor.mjs";

test("warns when an opted-in share advisory is exceeded", () => {
  const g = evaluateGovernor(
    { fable: { costUsd: 5, share: 0.75 } },
    { maxFableSharePct: 0.6, mode: "warn" },
  );
  assert.equal(g.fableCostUsd, 5);
  assert.ok(g.warnings.some((w) => w.type === "fable-share-high"));
});

test("no warnings when share is under target", () => {
  const g = evaluateGovernor({ fable: { costUsd: 1, share: 0.2 } });
  assert.equal(g.warnings.length, 0);
});

test("the share advisory is off unless a runtime policy opts in", () => {
  const off = evaluateGovernor({ fable: { costUsd: 50, share: 0.95 } });
  assert.equal(off.warnings.length, 0, "no advisory by default");
  const on = evaluateGovernor(
    { fable: { costUsd: 50, share: 0.95 } },
    { maxFableSharePct: 0.6 },
  );
  assert.equal(on.warnings[0].type, "fable-share-high");
  assert.equal(on.warnings[0].advisory, true);
});

test("there is no monthly target left to model the subscription as a budget", () => {
  const g = evaluateGovernor({ fable: { costUsd: 50, share: 0.3 } });
  assert.equal(g.monthlyTargetUsd, undefined);
  assert.equal(g.projectedMonthUsd, undefined);
  assert.equal(g.pctOfTarget, undefined);
});

test("loop gate only fires in enforce mode, at the soft budget", () => {
  assert.equal(
    shouldGateNextIteration(15, { mode: "enforce", perLoopSoftUsd: 10 }),
    true,
  );
  assert.equal(
    shouldGateNextIteration(5, { mode: "enforce", perLoopSoftUsd: 10 }),
    false,
  );
  // warn/observe never gate, even over budget.
  assert.equal(
    shouldGateNextIteration(15, { mode: "warn", perLoopSoftUsd: 10 }),
    false,
  );
});

test("readFablePolicy falls back to defaults when absent", () => {
  const p = readFablePolicy("/no/such/root/xyz");
  assert.equal(p.mode, "warn");
  assert.equal(p.perLoopSoftUsd, 10);
});
