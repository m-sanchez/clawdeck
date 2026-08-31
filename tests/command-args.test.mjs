// @ts-check
/**
 * Tests for the command registry surface: fixed argv building (a UI value must
 * never become an arbitrary argument) and checkout-tooling availability gating.
 * Run: node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMANDS,
  findCommand,
  commandAvailable,
} from "../server/lib/command-registry.mjs";

const CTX = { checkoutRoot: "/repo", panelRoot: "/panel" };
const cmd = (key) => COMMANDS.find((c) => c.key === key);

test("git commands build fixed argv against the requested cwd", () => {
  const r = cmd("git-status").build(CTX, { cwd: "/wt" });
  assert.equal(r.bin, "git");
  assert.deepEqual(r.args, ["-C", "/wt", "-c", "color.ui=never", "status"]);
});

test("no registry entry ever interpolates params into argv", () => {
  for (const c of COMMANDS) {
    const r = c.build(CTX, {
      cwd: "/wt",
      slug: "s",
      stamp: "t",
      params: { evil: "; rm -rf /" },
    });
    assert.ok(Array.isArray(r.args));
    assert.ok(!r.args.some((a) => String(a).includes("; rm -rf /")));
  }
});

test("findCommand returns null for unknown keys", () => {
  assert.equal(findCommand("nope"), null);
  assert.equal(findCommand("git-status")?.key, "git-status");
});

test("git commands are always available; script commands gate on the checkout", () => {
  const tmp = mkdtempSync(join(tmpdir(), "clawdeck-cmd-"));
  try {
    const ctx = { checkoutRoot: tmp, panelRoot: "/panel" };
    assert.equal(commandAvailable(ctx, cmd("git-status")), true);
    assert.equal(commandAvailable(ctx, cmd("wt-disk")), true);
    assert.equal(
      commandAvailable(ctx, cmd("wt-verify")),
      false,
      "script absent -> unavailable",
    );
    mkdirSync(join(tmp, ".claude", "scripts"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "scripts", "worktree-verify.mjs"), "");
    assert.equal(
      commandAvailable(ctx, cmd("wt-verify")),
      true,
      "script present -> available",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("an available() that throws reads as unavailable, never as a crash", () => {
  const broken = {
    key: "x",
    available: () => {
      throw new Error("boom");
    },
  };
  assert.equal(commandAvailable(CTX, broken), false);
});
