// @ts-check
/**
 * Allowlisted, named actions, the ONLY mutating operations the browser can
 * trigger. There is no arbitrary-command endpoint: each action maps to a fixed
 * repository script/module with typed, validated params. Every action either
 * reuses an existing safe lifecycle script or a pure state writer.
 */
import { spawn } from "node:child_process";
import { join, resolve, sep } from "node:path";
import {
  existsSync,
  writeFileSync,
  renameSync,
  readFileSync,
  copyFileSync,
} from "node:fs";
import { loadEsm } from "./repo-modules.mjs";
import { markSetup } from "./setup-state.mjs";
import { runPolicyAction } from "./policy-actions.mjs";
import { getWorktrees } from "../adapters/worktrees.mjs";
import { getReviews, appendReviewHistory } from "../adapters/reviews.mjs";
import {
  getValidation,
  validationReportPath,
  appendValidationHistory,
} from "../adapters/validation.mjs";

let validationInFlight = false;

function bad(message) {
  return { ok: false, error: message };
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

/**
 * Run a child process to completion, capturing stdout/stderr. Async (never
 * blocks the event loop) and never rejects; failures surface as a non-zero code.
 * @param {string} file @param {string[]} argv
 * @param {{ cwd?: string, input?: string, timeoutMs?: number }} [opts]
 */
function runChild(file, argv, opts = {}) {
  const { cwd, input, timeoutMs = 45000 } = opts;
  return new Promise((resolvePromise) => {
    const child = spawn(file, argv, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: String(e?.message || e) });
    });
    child.stdin.end(input ?? "");
  });
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} params
 * @param {{ ctx: any, hub: import('./http.mjs').EventHub, setReviews: Function, refresh: Function, resolveWorktree?: Function, spawn?: Function, secretScan?: Function }} deps
 */
export async function runAction(name, params, deps) {
  const { ctx, hub } = deps;
  switch (name) {
    case "review.run": {
      const reviews = await getReviews(ctx);
      deps.setReviews(reviews);
      if (reviews.status === "ok")
        appendReviewHistory(ctx.runtimeDir, {
          at: new Date().toISOString(),
          blockCount: Number(reviews.blockCount) || 0,
          warnCount: Number(reviews.warnCount) || 0,
          total: (reviews.findings ?? []).length,
        });
      hub.broadcast("panel", {
        type: "review.completed",
        status: reviews.status,
        blockCount: reviews.blockCount,
        emittedAt: new Date().toISOString(),
      });
      await deps.refresh();
      return { ok: true, reviews };
    }

    case "validation.run": {
      // Resolve the target worktree (or the current checkout); reject unknown paths.
      const target = params.worktreePath
        ? await deps.resolveWorktree(String(params.worktreePath))
        : { cwd: ctx.checkoutRoot, worktree: null };
      if (!target) return bad("Unknown or invalid worktree.");
      const slug =
        (target.worktree || "current")
          .replace(/[^a-zA-Z0-9._-]+/g, "-")
          .slice(0, 40) || "current";
      const script = join(
        target.cwd,
        ".claude",
        "scripts",
        "worktree-verify.mjs",
      );
      if (!existsSync(script))
        return bad("worktree-verify.mjs is not present in that checkout.");
      if (validationInFlight)
        return { ok: true, accepted: true, alreadyRunning: true };
      validationInFlight = true;
      hub.broadcast("panel", {
        type: "validation.started",
        worktree: target.worktree,
        emittedAt: new Date().toISOString(),
      });

      const child = spawn(process.execPath, [script, "--json"], {
        cwd: target.cwd,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d;
        for (const line of String(d).split(/\r?\n/)) {
          if (line.trim())
            hub.broadcast("panel", {
              type: "log",
              service: "validation",
              level: "info",
              message: line.trim(),
              emittedAt: new Date().toISOString(),
            });
        }
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("close", (code) => {
        validationInFlight = false;
        const report = parseLastJson(stdout) ?? {
          ok: code === 0,
          report: [],
          base: null,
          reason: stderr.slice(0, 500),
        };
        const ranAt = new Date().toISOString();
        const ok = report.ok ?? code === 0;
        writeJsonAtomic(validationReportPath(ctx.runtimeDir, slug), {
          ranAt,
          worktree: target.worktree,
          base: report.base ?? null,
          ok,
          report: report.report ?? [],
          reason:
            report.reason ??
            (report.setup
              ? `setup incomplete: ${JSON.stringify(report.setup).slice(0, 200)}`
              : stderr.slice(0, 300) || null),
          exitCode: code,
        });
        const rows = report.report ?? [];
        const count = (st) => rows.filter((r) => r.status === st).length;
        appendValidationHistory(ctx.runtimeDir, slug, {
          ranAt,
          ok: ok && code === 0,
          passed: count("pass"),
          failed: count("fail"),
          total: rows.length,
        });
        hub.broadcast("panel", {
          type: "validation.completed",
          worktree: target.worktree,
          ok: report.ok ?? code === 0,
          emittedAt: new Date().toISOString(),
        });
        deps.refresh();
      });
      child.on("error", (err) => {
        validationInFlight = false;
        hub.broadcast("panel", {
          type: "validation.completed",
          ok: false,
          message: err?.message,
          emittedAt: new Date().toISOString(),
        });
      });
      return { ok: true, accepted: true };
    }

    case "run.cancel": {
      const runId = String(params.runId ?? "");
      if (!runId || /[^\w.\-:]/.test(runId))
        return bad("A valid runId is required.");
      const mod = await loadEsm(
        ctx.checkoutRoot,
        ".claude/scripts/loop-state.mjs",
      );
      if (!mod?.cancelRun)
        return bad("loop-state.mjs is not present in this checkout.");
      const stateRoot = join(ctx.checkoutRoot, ".claude");
      const updated = mod.cancelRun(stateRoot, runId);
      if (!updated) return bad(`No such run: ${runId}`);
      hub.broadcast("panel", {
        type: "run.updated",
        runId,
        emittedAt: new Date().toISOString(),
      });
      await deps.refresh();
      return {
        ok: true,
        run: mod.finalReport ? mod.finalReport(updated) : updated,
      };
    }

    case "autoloop.create": {
      const task = String(params.task ?? "").trim();
      if (!task) return bad("A task description is required.");
      const mod = await loadEsm(
        ctx.checkoutRoot,
        ".claude/scripts/loop-state.mjs",
      );
      if (!mod?.createRun)
        return bad("loop-state.mjs is not present in this checkout.");
      const stateRoot = join(ctx.checkoutRoot, ".claude");
      const maxIterations = Number(params.maxIterations);
      const run = mod.createRun(stateRoot, {
        task,
        maxIterations: Number.isFinite(maxIterations)
          ? maxIterations
          : undefined,
        scope: params.scope ? String(params.scope) : null,
      });
      hub.broadcast("panel", {
        type: "run.started",
        runId: run.runId,
        emittedAt: new Date().toISOString(),
      });
      await deps.refresh();
      return { ok: true, run: mod.finalReport ? mod.finalReport(run) : run };
    }

    case "editor.open": {
      // Launch VS Code at a worktree (or a file:line). Fixed `code` binary; every
      // path is validated and canonicalised under the worktree before launch.
      const target = params.worktreePath
        ? await deps.resolveWorktree(String(params.worktreePath))
        : { cwd: ctx.checkoutRoot, worktree: null };
      if (!target) return bad("Unknown or invalid worktree.");
      // Reject chars dangerous inside a double-quoted shell arg; a newline is
      // included because cmd.exe ends the command at a line break even inside
      // quotes. Spaces and dashes are fine and common in real paths.
      const unsafe = /["%$`\r\n]/;
      if (unsafe.test(target.cwd)) return bad("Unsafe worktree path.");
      const root = resolve(target.cwd);
      let cmd;
      if (params.file != null) {
        const file = String(params.file);
        if (file.includes("..") || /^[\\/]/.test(file) || unsafe.test(file))
          return bad("Invalid file path.");
        const line = Math.max(1, parseInt(String(params.line ?? "1"), 10) || 1);
        const abs = resolve(root, file);
        if (abs !== root && !abs.startsWith(root + sep))
          return bad("Path escapes the worktree.");
        cmd = `code -g "${abs}:${line}"`;
      } else {
        cmd = `code "${root}"`;
      }
      try {
        const launch = deps.spawn || spawn;
        const child = launch(cmd, {
          shell: true,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.on("error", () => {});
        child.unref();
        return { ok: true, launched: true };
      } catch (err) {
        return bad(`Could not launch the editor: ${err?.message ?? err}`);
      }
    }

    case "remote.deleteBranch": {
      // Delete a branch on origin. Allowed ONLY for branches already merged into
      // the default branch (re-checked server-side), so an arbitrary or unmerged
      // branch can never be pushed/deleted from the panel.
      const branch = String(params.branch ?? "").trim();
      if (!branch || /[^\w.\-/]/.test(branch) || branch.includes(".."))
        return bad("Invalid branch name.");
      const { getMergedRemoteBranches } = await import(
        "../adapters/remote-branches.mjs"
      );
      const merged = await getMergedRemoteBranches(ctx);
      if (!merged.branches.includes(branch))
        return bad(
          "Refused: that branch is not in the merged-into-develop set.",
        );
      const result = await new Promise((resolvePromise) => {
        const p = spawn(
          "git",
          ["-C", ctx.checkoutRoot, "push", "origin", "--delete", branch],
          { windowsHide: true },
        );
        let stdout = "";
        let stderr = "";
        p.stdout.on("data", (d) => (stdout += d));
        p.stderr.on("data", (d) => (stderr += d));
        p.on("close", (code) => resolvePromise({ code, stdout, stderr }));
        p.on("error", (e) => resolvePromise({ code: -1, stderr: e.message }));
      });
      await deps.refresh();
      if (result.code !== 0)
        return bad(
          `git push failed: ${(result.stderr || result.stdout || "").slice(0, 300)}`,
        );
      return {
        ok: true,
        deleted: branch,
        output: (result.stdout || result.stderr || "").trim().slice(0, 300),
      };
    }

    case "findings.transition": {
      // Explicit Fix Station lifecycle transition (confirm / reject / mark
      // changed / request re-verify / resolve). Persisted; illegal transitions
      // are refused by the model's legal graph.
      const id = String(params.findingId ?? "");
      const to = String(params.to ?? "");
      if (!/^f_[a-z0-9]+$/.test(id)) return bad("Invalid finding id.");
      const { readFindingStore, writeFindingStore, transitionFinding } =
        await import("../core/findings/store.mjs");
      const store = readFindingStore(ctx.runtimeDir);
      const res = transitionFinding(store, id, to, {
        actor: "panel",
        reason: params.reason != null ? String(params.reason) : undefined,
        fixSession: params.fixSession ? String(params.fixSession) : undefined,
        commit: params.commit ? String(params.commit) : undefined,
      });
      if (!res.ok) return { ok: false, error: res.error, from: res.from };
      writeFindingStore(ctx.runtimeDir, store);
      hub.broadcast("panel", {
        type: "finding.updated",
        findingId: id,
        state: res.finding.state,
        emittedAt: new Date().toISOString(),
      });
      await deps.refresh();
      return { ok: true, findingId: id, state: res.finding.state };
    }

    case "claude.open": {
      // Resolve the worktree, scan the prompt for secret material, then (only if
      // clean) return a claude-cli:// deep link the CLIENT opens. The link opens
      // Claude in that cwd with the prompt PREFILLED but NOT submitted; no shell,
      // no spawn, nothing auto-executed. A prompt with detected secret material is
      // REFUSED, fail-closed: a URL can leak through browser history, the OS
      // handler, or logs, so no secret may enter it. Copy prompt stays a separate
      // explicit user action; the secret value never enters the response.
      const target = params.worktreePath
        ? await deps.resolveWorktree(String(params.worktreePath))
        : { cwd: ctx.checkoutRoot, worktree: null };
      if (!target) return bad("Unknown or invalid worktree.");
      const prompt = params.prompt != null ? String(params.prompt) : "";
      const scanner = deps.secretScan
        ? { scanText: deps.secretScan }
        : await import("./secret-scan.mjs");
      if (!scanner || typeof scanner.scanText !== "function") {
        return {
          ok: false,
          refused: true,
          reason: "Secret scanner unavailable; refused to build a Claude link.",
        };
      }
      const hits = scanner.scanText(prompt) || [];
      if (hits.length) {
        // Only the distinct pattern NAMES (redacted); never the matched value.
        return {
          ok: false,
          refused: true,
          reason:
            "The prompt contains suspected secret material; refused to build a Claude link. Remove it, or use Copy prompt.",
          patterns: [...new Set(hits.map((h) => h.pattern))].sort(),
        };
      }
      const { buildClaudeDeepLink } = await import(
        "../../ui/lib/open-in-claude.mjs"
      );
      const link = buildClaudeDeepLink({ cwd: target.cwd, prompt });
      return {
        ok: true,
        url: link.url,
        cwd: target.cwd,
        worktree: target.worktree,
        truncated: link.truncated,
        promptChars: link.promptChars,
      };
    }

    case "policy.approve":
    case "policy.reject":
    case "policy.grantCapability":
    case "policy.revokeCapability": {
      const op =
        /** @type {Record<string, "approve"|"reject"|"grant"|"revoke">} */ ({
          "policy.approve": "approve",
          "policy.reject": "reject",
          "policy.grantCapability": "grant",
          "policy.revokeCapability": "revoke",
        })[name];
      const trees = await getWorktrees(ctx);
      const roots = [
        ctx.checkoutRoot,
        ...trees.map((w) => w.path).filter(Boolean),
      ];
      const result = runPolicyAction(ctx, roots, op, params);
      if (result.ok) {
        hub.broadcast("panel", {
          type: "policy.updated",
          sessionId: result.sessionId,
          state: result.state,
          revision: result.revision,
          emittedAt: new Date().toISOString(),
        });
        await deps.refresh();
      }
      return result;
    }

    case "config.read":
      return { ok: true, config: readEditableConfig(ctx.checkoutRoot) };

    case "config.save":
      return saveEditableConfig(ctx.checkoutRoot, params);

    case "setup.complete":
      return { ok: true, setup: markSetup(ctx.runtimeDir, "completed") };

    case "setup.skip":
      return { ok: true, setup: markSetup(ctx.runtimeDir, "skipped") };

    default:
      return bad(`Unknown action: ${name}`);
  }
}

export const ACTION_NAMES = [
  "review.run",
  "validation.run",
  "run.cancel",
  "autoloop.create",
  "editor.open",
  "claude.open",
  "findings.transition",
  "remote.deleteBranch",
  "policy.approve",
  "policy.reject",
  "policy.grantCapability",
  "policy.revokeCapability",
  "config.read",
  "config.save",
  "setup.complete",
  "setup.skip",
];

function settingsPath(checkoutRoot) {
  return join(checkoutRoot, ".claude", "settings.local.json");
}
function readSettings(checkoutRoot) {
  try {
    return JSON.parse(readFileSync(settingsPath(checkoutRoot), "utf8"));
  } catch {
    return {};
  }
}

/** Sanitised editable config: never returns secret VALUES, only set/unset. */
function readEditableConfig(checkoutRoot) {
  const s = readSettings(checkoutRoot);
  return {
    gitlabTokenSet: Boolean(s.env && s.env.GITLAB_TOKEN),
    githubTokenSet: Boolean(s.env && s.env.GITHUB_TOKEN),
  };
}

/**
 * Merge forge-token edits into the checkout's settings.local.json: back up
 * first, preserve keys we don't manage, and treat a blank value as
 * keep-existing so a token is never clobbered by an empty field.
 */
function saveEditableConfig(checkoutRoot, params) {
  const gitlabToken =
    typeof params.gitlabToken === "string" ? params.gitlabToken.trim() : "";
  const githubToken =
    typeof params.githubToken === "string" ? params.githubToken.trim() : "";

  if (gitlabToken || githubToken) {
    const p = settingsPath(checkoutRoot);
    const s = readSettings(checkoutRoot);
    s.env = s.env || {};
    if (gitlabToken) s.env.GITLAB_TOKEN = gitlabToken;
    if (githubToken) s.env.GITHUB_TOKEN = githubToken;
    if (existsSync(p)) copyFileSync(p, p + ".bak");
    try {
      writeJsonAtomic(p, s);
    } catch (e) {
      return bad(`Could not write settings: ${String((e && e.message) || e)}`);
    }
  }

  return { ok: true, config: readEditableConfig(checkoutRoot) };
}

/** Parse the last complete top-level JSON object printed on stdout. */
function parseLastJson(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  // Fast path: the whole output is one JSON object.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to scan */
  }
  const start = trimmed.lastIndexOf("\n{");
  if (start !== -1) {
    try {
      return JSON.parse(trimmed.slice(start + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export { getValidation };
