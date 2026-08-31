// @ts-check
/** Round-K: the editor.open action must not let a param reach the shell. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAction } from "../server/lib/actions.mjs";

test("editor.open rejects a newline in the file path and never reaches the shell", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "editor-open-"));
  let launched = null;
  const deps = {
    ctx: { checkoutRoot: root },
    hub: { broadcast() {} },
    resolveWorktree: async () => ({ cwd: root, worktree: null }),
    spawn: (cmd) => {
      launched = cmd;
      return { on() {}, unref() {} };
    },
  };
  // A newline breaks out of the double-quoted arg on cmd.exe (second line runs).
  const res = await runAction(
    "editor.open",
    { worktreePath: root, file: "a\ncalc", line: 1 },
    deps,
  );
  assert.equal(res.ok, false, "a newline in the file must be rejected");
  assert.equal(launched, null, "no shell command may be launched");

  // A clean relative file still launches, with no newline in the command.
  const ok = await runAction(
    "editor.open",
    { worktreePath: root, file: "src/app.ts", line: 5 },
    deps,
  );
  assert.equal(ok.ok, true, "a clean file launches");
  assert.ok(
    launched && !/[\r\n]/.test(launched),
    "the launched command carries no newline",
  );
  fs.rmSync(root, { recursive: true, force: true });
});
