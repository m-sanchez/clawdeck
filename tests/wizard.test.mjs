// @ts-check
/** Unit tests for the setup wizard step model + server-side first-run state. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveWizardModel } from "../ui/lib/wizard.mjs";
import { readSetupState, markSetup } from "../server/lib/setup-state.mjs";

test("deriveWizardModel returns the four steps in order", () => {
  const ids = deriveWizardModel().map((s) => s.id);
  assert.deepEqual(ids, ["welcome", "forge", "prefs", "finish"]);
});

test("the forge step is optional and reflects whether a token is configured", () => {
  const off = deriveWizardModel({ forgeConfigured: false })[1];
  const on = deriveWizardModel({ forgeConfigured: true })[1];
  assert.equal(off.id, "forge");
  assert.equal(off.optional, true);
  assert.equal(off.satisfied, false);
  assert.equal(on.satisfied, true);
});

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "panel-setup-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readSetupState reports firstRun until the wizard is finished or skipped", () => {
  withTmp((dir) => {
    assert.equal(readSetupState(dir).firstRun, true);
    const done = markSetup(dir, "completed", "2026-01-01T00:00:00.000Z");
    assert.equal(done.firstRun, false);
    assert.equal(done.completed, true);
    assert.equal(done.completedAt, "2026-01-01T00:00:00.000Z");
    // A persisted state is read back identically by a fresh read.
    assert.equal(readSetupState(dir).firstRun, false);
  });
});

test("skipping also clears firstRun and keeps any prior completion", () => {
  withTmp((dir) => {
    markSetup(dir, "completed", "2026-01-01T00:00:00.000Z");
    const skipped = markSetup(dir, "skipped", "2026-01-02T00:00:00.000Z");
    assert.equal(skipped.firstRun, false);
    assert.equal(skipped.completed, true);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.completedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(skipped.skippedAt, "2026-01-02T00:00:00.000Z");
  });
});

test("markSetup rejects an unknown status", () => {
  withTmp((dir) => {
    assert.throws(() => markSetup(dir, "bogus"), /Invalid setup status/);
  });
});
