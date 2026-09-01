// @ts-check
/**
 * What a task actually did, from git rather than from what it said.
 *
 * A task claims an outcome; this module looks for the traces that outcome would
 * have left. Files changed since the task was bound, and the commit that
 * carries them - established by intersecting the commit's own file list with
 * the task's, so a commit that merely landed at the right moment is not
 * attributed to the task.
 *
 * Every answer can be "unknown". A task whose binding time is unknown, or whose
 * git commands fail, yields no evidence rather than a confident empty result -
 * the difference between "it changed nothing" and "we could not tell".
 */
import { git, gitResult } from "../../lib/git.mjs";

// git expands %x00 itself; a real NUL cannot be passed as a spawn argument.
const NUL = "\u0000";

/** Uncommitted work, which is still work the task did. */
async function dirtyFiles(cwd, run) {
  const [tracked, untracked] = await Promise.all([
    run(["diff", "--name-only", "HEAD"], cwd),
    run(["ls-files", "--others", "--exclude-standard"], cwd),
  ]);
  const lines = `${tracked.stdout ?? ""}\n${untracked.stdout ?? ""}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    files: tracked.ok && untracked.ok ? new Set(lines) : null,
    ok: tracked.ok && untracked.ok,
  };
}

/**
 * Commits made since the task began, newest first, each with its files.
 *
 * A commit RANGE is used when the task recorded the commit HEAD sat on at bind
 * time: `baseline..HEAD` is exact. The timestamp window is only a fallback for
 * tasks bound before baselines existed, and it is weaker - git's `--since`
 * resolves to whole seconds, so a commit made in the same second as the bind
 * lands inside the window.
 */
async function commitsSince(cwd, task, run) {
  const range = task.baselineSha ? `${task.baselineSha}..HEAD` : null;
  const r = await run(
    range
      ? ["log", range, "--format=%x00%H %cI", "--name-only"]
      : ["log", `--since=${task.startedAt}`, "--format=%x00%H %cI", "--name-only"],
    cwd,
  );
  if (!r.ok) return null;
  const commits = [];
  let current = null;
  for (const raw of r.stdout.split("\n")) {
    const lineText = raw.trim();
    if (!lineText) continue;
    if (lineText.startsWith(NUL)) {
      const [sha, at] = lineText.slice(NUL.length).split(" ");
      current = { sha, at, files: [] };
      commits.push(current);
    } else if (current) {
      current.files.push(lineText);
    }
  }
  return commits;
}

/**
 * Collect evidence for one task.
 *
 * @param {string} cwd
 * @param {object} task
 * @param {{now?: number, gitResult?: Function, git?: Function}} [deps]
 * @returns {Promise<{files: string[], commit: object|null, dirty: string[],
 *                    reasons: string[], unknowns: string[]}>}
 */
export async function collectTaskEvidence(cwd, task, deps = {}) {
  const run = deps.gitResult || gitResult;
  const reasons = [];
  const unknowns = [];

  const since = task?.startedAt ?? null;
  if (!since) {
    return {
      files: [],
      commit: null,
      dirty: [],
      reasons: ["the task has not been bound to a session yet"],
      unknowns: ["start-time"],
    };
  }

  const dirty = await dirtyFiles(cwd, run);
  if (!dirty.ok) unknowns.push("working-tree");

  const commits = await commitsSince(cwd, task, run);
  if (commits == null) unknowns.push("commits");
  // Without a baseline the window is a timestamp, which can only be approximate.
  if (!task.baselineSha) unknowns.push("time-based-window");

  // Files the task is known to have touched: uncommitted edits plus anything
  // in commits made after it started.
  const touched = new Set(dirty.files ?? []);
  for (const c of commits ?? []) for (const f of c.files) touched.add(f);

  // A commit counts as this task's only if it shares files with what the task
  // touched. Landing after the task started is not, by itself, attribution.
  let commit = null;
  if (commits?.length) {
    const scored = commits
      .map((c) => ({
        ...c,
        overlap: c.files.filter((f) => touched.has(f)).length,
      }))
      .filter((c) => c.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || b.at.localeCompare(a.at));
    if (
      scored.length === 1 ||
      (scored[0] && scored[0].overlap > (scored[1]?.overlap ?? 0))
    ) {
      commit = { sha: scored[0].sha, at: scored[0].at, files: scored[0].files };
      reasons.push(
        `commit ${commit.sha.slice(0, 7)} touches ${scored[0].overlap} file(s) this task changed`,
      );
    } else if (scored.length > 1) {
      unknowns.push("commit-attribution");
      reasons.push(
        "several commits touch the same files; none is attributed to this task",
      );
    }
  }

  if (dirty.files?.size)
    reasons.push(`${dirty.files.size} file(s) with uncommitted changes`);
  if (!touched.size && !unknowns.length)
    reasons.push("no files changed since the task started");

  return {
    files: [...touched].sort(),
    commit,
    dirty: [...(dirty.files ?? [])].sort(),
    reasons,
    unknowns,
  };
}

/**
 * Tests observed for a task, from the validation report the panel already
 * keeps. Absent means unknown: Clawdeck does not run tests to find out.
 */
export function testEvidence(validation) {
  const checks = Array.isArray(validation?.checks) ? validation.checks : null;
  if (!checks) return { tests: [], unknown: true };
  return {
    tests: checks
      .filter((c) => c.status === "passed" || c.status === "failed")
      .map((c) => ({ id: c.id, label: c.label, status: c.status })),
    unknown: false,
  };
}

/** Convenience for callers that only have the string-returning git helper. */
export async function headSha(cwd, run = git) {
  return (await run(["rev-parse", "HEAD"], cwd)) || null;
}
