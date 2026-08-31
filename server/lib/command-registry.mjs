// @ts-check
/**
 * The fixed allowlist of commands the panel may run. There is NO arbitrary command
 * path: each entry maps to a concrete (bin, args) built server-side. Mutating or
 * destructive operations (push, reset, clean --apply) are deliberately absent;
 * the panel surfaces Claude slash-commands as copyable text instead of executing
 * them. `scope` controls whether a command may target a chosen worktree.
 *
 * Entries with `available(ctx)` depend on tooling the observed checkout may or
 * may not provide (a script under its .claude/scripts/); unavailable entries are
 * hidden from the listing and refused at execution.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const EXEC = process.execPath;

/** True when the observed checkout provides the given .claude/scripts file. */
function checkoutScript(rel) {
  return (ctx) => existsSync(join(ctx.checkoutRoot, ".claude", "scripts", rel));
}

/**
 * @typedef {{
 *   key: string, label: string, description: string, group: string,
 *   scope: 'both'|'worktree'|'checkout', mutating?: boolean, network?: boolean,
 *   available?: (ctx: any) => boolean,
 *   build: (ctx: any, opts: { cwd: string, slug: string, stamp: string, params?: any }) => { bin: string, args: string[], artifactPath?: string }
 * }} Command
 */

/** @type {Command[]} */
export const COMMANDS = [
  {
    key: "wt-verify",
    label: "Verify change set",
    description: "The checkout's own change-set verification script.",
    group: "Validation",
    scope: "both",
    available: checkoutScript("worktree-verify.mjs"),
    build: (_ctx, { cwd }) => ({
      bin: EXEC,
      args: [join(cwd, ".claude", "scripts", "worktree-verify.mjs")],
    }),
  },
  {
    key: "test-changed",
    label: "Test changed files",
    description: "The checkout's changed-files test script.",
    group: "Tests",
    scope: "both",
    available: checkoutScript("test-changed.mjs"),
    build: (_ctx, { cwd }) => ({
      bin: EXEC,
      args: [join(cwd, ".claude", "scripts", "test-changed.mjs")],
    }),
  },
  {
    key: "fix-lint",
    label: "Format & lint-fix",
    description:
      "The checkout's format/lint-fix script. Writes to the working tree.",
    group: "Quality",
    scope: "both",
    mutating: true,
    available: checkoutScript("fix-lint.mjs"),
    build: (_ctx, { cwd }) => ({
      bin: EXEC,
      args: [join(cwd, ".claude", "scripts", "fix-lint.mjs")],
    }),
  },
  {
    key: "clean-dry",
    label: "Clean (dry run)",
    description:
      "Preview build-artifact / dependency cleanup. Never deletes (dry run).",
    group: "Quality",
    scope: "both",
    available: checkoutScript("clean.mjs"),
    build: (_ctx, { cwd }) => ({
      bin: EXEC,
      args: [join(cwd, ".claude", "scripts", "clean.mjs")],
    }),
  },
  {
    key: "git-status",
    label: "git status",
    description: "Working-tree status (read-only).",
    group: "Git",
    scope: "both",
    build: (_ctx, { cwd }) => ({
      bin: "git",
      args: ["-C", cwd, "-c", "color.ui=never", "status"],
    }),
  },
  {
    key: "git-log",
    label: "git log (20)",
    description: "Recent commit graph (read-only).",
    group: "Git",
    scope: "both",
    build: (_ctx, { cwd }) => ({
      bin: "git",
      args: [
        "-C",
        cwd,
        "-c",
        "color.ui=never",
        "log",
        "-20",
        "--oneline",
        "--decorate",
        "--graph",
      ],
    }),
  },
  {
    key: "git-diffstat",
    label: "git diff --stat",
    description: "Summary of working-tree changes (read-only).",
    group: "Git",
    scope: "both",
    build: (_ctx, { cwd }) => ({
      bin: "git",
      args: ["-C", cwd, "-c", "color.ui=never", "diff", "--stat"],
    }),
  },
  {
    key: "git-fetch",
    label: "git fetch --prune",
    description: "Update remote refs (no working-tree change).",
    group: "Git",
    scope: "both",
    network: true,
    build: (_ctx, { cwd }) => ({
      bin: "git",
      args: ["-C", cwd, "fetch", "--prune"],
    }),
  },
  {
    key: "wt-doctor",
    label: "Worktree doctor",
    description:
      "Repo-wide read-only health: registered vs orphan, dirty, processes, ports, cleanup class.",
    group: "Worktrees",
    scope: "checkout",
    available: checkoutScript("worktree-lifecycle.mjs"),
    build: (_ctx, { cwd }) => ({
      bin: EXEC,
      args: [
        join(cwd, ".claude", "scripts", "worktree-lifecycle.mjs"),
        "doctor",
      ],
    }),
  },
  {
    key: "wt-cleanup-dry",
    label: "Worktree cleanup (dry run)",
    description:
      "Preview which worktrees are safe to remove. Never removes anything (dry run).",
    group: "Worktrees",
    scope: "checkout",
    available: checkoutScript("worktree-lifecycle.mjs"),
    build: (_ctx, { cwd }) => ({
      bin: EXEC,
      args: [
        join(cwd, ".claude", "scripts", "worktree-lifecycle.mjs"),
        "cleanup",
      ],
    }),
  },
  {
    key: "wt-cleanup-apply",
    label: "Worktree cleanup (apply)",
    description:
      "Remove proven-safe worktrees for real. The lifecycle script still refuses dirty / running / uncertain ones.",
    group: "Worktrees",
    scope: "checkout",
    mutating: true,
    available: checkoutScript("worktree-lifecycle.mjs"),
    build: (_ctx, { cwd }) => ({
      bin: EXEC,
      args: [
        join(cwd, ".claude", "scripts", "worktree-lifecycle.mjs"),
        "cleanup",
        "--apply",
      ],
    }),
  },
  {
    key: "wt-disk",
    label: "Worktree disk footprint",
    description:
      "Read-only size of the worktree's source, excluding node_modules / .git / build output.",
    group: "Worktrees",
    scope: "both",
    build: (ctx, { cwd }) => ({
      bin: EXEC,
      args: [join(ctx.panelRoot, "server", "jobs", "wt-disk.mjs"), cwd],
    }),
  },
];

export function findCommand(key) {
  return COMMANDS.find((c) => c.key === key) || null;
}

/** True when a command may run against this checkout. */
export function commandAvailable(ctx, command) {
  try {
    return command.available ? Boolean(command.available(ctx)) : true;
  } catch {
    return false;
  }
}
