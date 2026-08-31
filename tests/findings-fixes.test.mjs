// @ts-check
/** Regression tests for the external-review findings. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relTime } from "../ui/lib/dom.mjs";
import {
  getValidation,
  validationReportPath,
} from "../server/adapters/validation.mjs";
import { getReadiness } from "../server/adapters/readiness.mjs";

test("relTime: past reads 'ago', future reads 'in' (was reversed)", () => {
  assert.match(relTime(Date.now() - 5 * 60_000), /^5m ago$/);
  assert.match(relTime(Date.now() + 5 * 60_000), /^in 5m$/);
});

test("getValidation: a failed verify execution is a blocking failure, not 'no scope'", () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-val-"));
  writeFileSync(
    validationReportPath(dir, "current"),
    JSON.stringify({
      ranAt: new Date(0).toISOString(),
      base: "develop",
      ok: false,
      report: [],
      reason: "deps missing",
      exitCode: 1,
    }),
  );
  const v = getValidation({ runtimeDir: dir }, "current");
  assert.equal(v.passed, false);
  const failed = v.checks.filter((c) => c.status === "failed");
  assert.equal(failed.length, 1, "synthetic execution-failure check present");
  assert.equal(failed[0].blocking, true);
  assert.match(failed[0].summary || "", /deps missing/);
});

test("getValidation: a clean run with no checks stays empty (genuine 'no scope')", () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-val-"));
  writeFileSync(
    validationReportPath(dir, "current"),
    JSON.stringify({
      ranAt: new Date(0).toISOString(),
      ok: true,
      report: [],
      exitCode: 0,
    }),
  );
  const v = getValidation({ runtimeDir: dir }, "current");
  assert.equal(v.checks.length, 0);
  assert.equal(v.passed, false); // no checks -> not "passing", but no failed check either
});

test("getReadiness: a failed validation makes the checkout NOT ready", () => {
  const validationFailing = {
    status: "ok",
    checks: [
      { status: "failed", project: "(runner)", label: "verify execution" },
    ],
  };
  const reviewsClean = { status: "ok", blockCount: 0, warnCount: 0 };
  const r = getReadiness(
    { checkoutRoot: tmpdir() },
    "abc1234",
    validationFailing,
    reviewsClean,
  );
  assert.equal(r.ready, false);
  const ev = r.evidence.find((e) => e.label === "Validation passing");
  assert.equal(ev.ok, false);
});
