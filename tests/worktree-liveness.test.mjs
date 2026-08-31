// @ts-check
/**
 * Regression: a checkout that has the panel package but NOT the optional central
 * worktree registry (.claude/scripts/worktree-registry.mjs) must still classify a
 * live owned panel instance as "running". Previously the PID-liveness fallback was
 * `() => false`, so every owned panel read as "stopped" when the registry was absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorktrees } from "../server/adapters/worktrees.mjs";

function git(dir, args) {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

test("panel instance reads as running without the central registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-wt-live-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "init",
    ]);
    // Owned panel instance registry for THIS live process. No worktree-registry.mjs.
    const instDir = join(dir, ".claude", ".runtime", "panel", "inst1");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(
      join(instDir, "registry.json"),
      JSON.stringify({
        services: [{ id: "panel", pid: process.pid, port: 5999 }],
      }),
    );

    const worktrees = await getWorktrees({
      checkoutRoot: dir,
      repoRoot: dir,
    });
    const services = worktrees.flatMap((w) => w.services ?? []);
    const panel = services.find((s) => s.id === "panel:panel");
    assert.ok(panel, "owned panel instance should be discovered");
    assert.equal(panel.status, "running", "live PID must read as running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
