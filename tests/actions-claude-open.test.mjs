// @ts-check
/**
 * The claude.open action returns a claude-cli:// deep link for the client to open
 * (no shell, no spawn, no auto-submit), AND fail-closed refuses to build a URL for
 * a prompt containing detected secret material, never leaking the secret value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAction } from "../server/lib/actions.mjs";

function deps(root, onSpawn, secretScan) {
  return {
    ctx: { checkoutRoot: root },
    hub: { broadcast() {} },
    resolveWorktree: async (p) => ({ cwd: p || root, worktree: p || null }),
    refresh: async () => {},
    setReviews: () => {},
    secretScan: secretScan || (() => []),
    spawn: (...a) => {
      onSpawn(a);
      return { on() {}, unref() {} };
    },
  };
}

test("claude.open returns a claude-cli:// deep link and spawns nothing", async () => {
  let spawned = false;
  const res = await runAction(
    "claude.open",
    { worktreePath: "/repo/wt-x", prompt: "fix the failing validation" },
    deps("/repo/main", () => (spawned = true)),
  );
  assert.equal(res.ok, true);
  assert.ok(String(res.url).startsWith("claude-cli://open?"));
  assert.ok(res.url.includes("cwd=" + encodeURIComponent("/repo/wt-x")));
  assert.ok(
    res.url.includes("q=" + encodeURIComponent("fix the failing validation")),
  );
  assert.equal(res.truncated, false);
  assert.equal(spawned, false, "the action must never spawn a process");
});

test("claude.open uses the checkout root when no worktree is given", async () => {
  let spawned = false;
  const res = await runAction(
    "claude.open",
    { prompt: "x" },
    deps("/repo/main", () => (spawned = true)),
  );
  assert.equal(res.ok, true);
  assert.ok(res.url.includes("cwd=" + encodeURIComponent("/repo/main")));
  assert.equal(spawned, false);
});

test("claude.open refuses an unknown worktree (no link, no spawn)", async () => {
  let spawned = false;
  const d = deps("/repo/main", () => (spawned = true));
  d.resolveWorktree = async () => null;
  const res = await runAction(
    "claude.open",
    { worktreePath: "/nope", prompt: "x" },
    d,
  );
  assert.equal(res.ok, false);
  assert.equal(spawned, false);
});

test("claude.open refuses a prompt with detected secret material, never leaking it", async () => {
  const SECRET = "glpat-" + "Xk9mQ2pL7vB3nR8sT4wZ"; // synthetic PAT shape
  let spawned = false;
  const scan = (t) =>
    t.includes("glpat-")
      ? [{ pattern: "gitlab-pat", line: 1, value: SECRET }]
      : [];
  const res = await runAction(
    "claude.open",
    { worktreePath: "/repo/wt", prompt: `deploy with ${SECRET} now` },
    deps("/repo/main", () => (spawned = true), scan),
  );
  assert.equal(res.ok, false);
  assert.equal(res.refused, true);
  assert.equal(
    res.url,
    undefined,
    "no URL is built for a secret-bearing prompt",
  );
  assert.equal(spawned, false);
  const blob = JSON.stringify(res);
  assert.ok(
    !blob.includes(SECRET),
    "the secret value never appears in the response",
  );
  assert.ok(!blob.includes("Xk9mQ2pL7vB3nR8sT4wZ"), "no secret body leaks");
  assert.deepEqual(
    res.patterns,
    ["gitlab-pat"],
    "only the pattern NAME is surfaced",
  );
});

test("claude.open builds a link for a clean prompt", async () => {
  const res = await runAction(
    "claude.open",
    { worktreePath: "/repo/wt", prompt: "just fix the tests" },
    deps(
      "/repo/main",
      () => {},
      () => [],
    ),
  );
  assert.equal(res.ok, true);
  assert.ok(res.url.startsWith("claude-cli://open?"));
});

test("claude.open uses the REAL scanner (loadEsm) and refuses a synthetic PAT", async () => {
  // No injected scanner: exercise the production loadEsm path against the actual
  // repo so the guard is proven end-to-end.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..", ".."); // worktree root
  const SECRET = "glpat-" + "Ab3xY7zQ1mN5pR8sT2wK"; // synthetic gitlab PAT shape
  const res = await runAction(
    "claude.open",
    { worktreePath: repoRoot, prompt: `the token is ${SECRET}` },
    {
      ctx: { checkoutRoot: repoRoot },
      hub: { broadcast() {} },
      resolveWorktree: async (p) => ({ cwd: p || repoRoot, worktree: null }),
      refresh: async () => {},
      setReviews: () => {},
      spawn: () => ({ on() {}, unref() {} }),
    },
  );
  assert.equal(res.ok, false, "the real scanner must refuse a synthetic PAT");
  assert.equal(res.refused, true);
  assert.ok(
    (res.patterns || []).includes("gitlab-pat"),
    "the real scanner ran and matched the PAT family",
  );
  assert.ok(!JSON.stringify(res).includes(SECRET), "no secret in the response");
});
