// @ts-check
/** Unit tests for the Open-in-Claude command builder. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCommand } from "../ui/lib/open-in-claude.mjs";

test("defaults to plan mode (cannot mutate until approved)", () => {
  assert.equal(buildClaudeCommand().display, "claude --permission-mode plan");
});

test("model is honoured only from the fixed allowlist", () => {
  assert.equal(
    buildClaudeCommand({ model: "opus" }).display,
    "claude --permission-mode plan --model opus",
  );
  // An unknown / malicious model value is dropped, never passed through.
  assert.equal(
    buildClaudeCommand({ model: "; rm -rf /" }).display,
    "claude --permission-mode plan",
  );
});

test("permission mode is validated; unknown falls back to plan", () => {
  assert.equal(
    buildClaudeCommand({ permissionMode: "acceptEdits" }).display,
    "claude --permission-mode acceptEdits",
  );
  assert.equal(
    buildClaudeCommand({ permissionMode: "evil`x`" }).display,
    "claude --permission-mode plan",
  );
});

test("injection-safe by construction: no free-text ever reaches the command", () => {
  const cmd = buildClaudeCommand({
    model: "'; evil",
    permissionMode: "$(evil)",
  });
  assert.ok(!/evil|rm |;|`|\$\(/.test(cmd.display));
  // args are a fixed, validated list — there is no prompt/cwd interpolation.
  assert.ok(cmd.args.every((a) => /^[\w-]+$/.test(a) || a === "plan"));
});
