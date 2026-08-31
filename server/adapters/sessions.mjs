// @ts-check
/**
 * Sessions / agents adapter. Each Claude Code checkout keeps a session transcript
 * dir under `~/.claude/projects/<munged-path>/`; a recently-modified `*.jsonl` is a
 * live agent. We read only transcript filenames + mtimes (never transcript CONTENT)
 * and map each dir back to its worktree. The session's task list is read separately
 * from the purpose-built harness task store at `~/.claude/tasks/<sessionId>/` (one
 * tiny JSON per task), so the panel can show "how far is each agent through its
 * task list" without parsing the multi-MB transcript.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ACTIVE_MS = 12 * 60 * 1000;
const SAMPLE_FRESH_MS = 3 * 60 * 1000;

/**
 * Active iff the transcript mtime OR a live statusline sample is fresh. The
 * sample is the stronger signal but only ADDS liveness: a stale sample never
 * marks a session dead while its transcript mtime is still fresh.
 * @param {{ lastMs:number, sampleAgeMs:number|null, now:number }} a
 */
export function agentIsActive({ lastMs, sampleAgeMs, now }) {
  const mtimeActive = lastMs > 0 && now - lastMs < ACTIVE_MS;
  const sampleFresh = sampleAgeMs != null && sampleAgeMs < SAMPLE_FRESH_MS;
  return mtimeActive || sampleFresh;
}

/**
 * Task-list progress for one session from the harness task store. The store keys
 * a task group by the session id (== transcript filename), each task a small JSON
 * with a status. Returns null when the session has no task group.
 * @returns {{ total:number, completed:number, inProgress:number, pending:number, pct:number, current:string|null }|null}
 */
function readTaskGroup(tasksRoot, sessionId) {
  if (!sessionId) return null;
  let names;
  try {
    names = readdirSync(join(tasksRoot, sessionId));
  } catch {
    return null;
  }
  let total = 0,
    completed = 0,
    inProgress = 0,
    pending = 0;
  let current = null;
  // 1.json, 2.json, ... in creation order so the first in-progress task is the
  // earliest one still open: the best single "what is it doing now" line.
  const ordered = names
    .filter((n) => /^\d+\.json$/.test(n))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  for (const name of ordered) {
    let t;
    try {
      t = JSON.parse(readFileSync(join(tasksRoot, sessionId, name), "utf8"));
    } catch {
      continue;
    }
    if (!t || typeof t.status !== "string") continue;
    total++;
    if (t.status === "completed") completed++;
    else if (t.status === "in_progress") {
      inProgress++;
      if (!current) current = t.activeForm || t.subject || null;
    } else pending++;
  }
  if (!total) return null;
  return {
    total,
    completed,
    inProgress,
    pending,
    pct: completed / total,
    current,
  };
}

/** Claude munges a checkout path into its projects-dir slug. */
export function slugForPath(p) {
  return String(p).replace(/[\\/:.]/g, "-");
}

const RECENT_CAP = 6;

/**
 * Count + the most-recent transcript files in a session dir. Reads ONLY filenames
 * and mtimes, never transcript content.
 */
function dirActivity(dir) {
  const empty = { count: 0, lastMs: 0, latest: null, recent: [] };
  if (!existsSync(dir)) return empty;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return empty;
  }
  /** @type {{ id: string, mtimeMs: number }[]} */
  const files = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      files.push({
        id: name.replace(/\.jsonl$/, ""),
        mtimeMs: statSync(join(dir, name)).mtimeMs,
      });
    } catch {
      /* skip unreadable entry */
    }
  }
  if (!files.length) return empty;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    count: files.length,
    lastMs: files[0].mtimeMs,
    latest: files[0].id,
    recent: files.slice(0, RECENT_CAP),
  };
}

/**
 * @param {{ checkoutRoot: string }} ctx
 * @param {Array<{ path: string, branch: string, isCurrent?: boolean }>} worktrees
 * @param {string} [ownSessionId] the panel's own session (env), to flag "this session"
 * @param {{ sessions?: Record<string, any> }} [telemetry] live per-session samples
 */
export function getSessions(ctx, worktrees, ownSessionId, telemetry) {
  const projectsRoot = join(homedir(), ".claude", "projects");
  const tasksRoot = join(homedir(), ".claude", "tasks");
  const now = Date.now();
  const agents = [];
  for (const w of worktrees || []) {
    const dir = join(projectsRoot, slugForPath(w.path));
    const a = dirActivity(dir);
    if (a.count === 0) continue;
    const sample = telemetry?.sessions?.[a.latest] ?? null;
    const sampleAgeMs = sample && sample.ageMs != null ? sample.ageMs : null;
    agents.push({
      branch: w.branch || "(detached)",
      path: w.path,
      isCurrent: Boolean(w.isCurrent),
      sessionCount: a.count,
      lastActivity: a.lastMs ? new Date(a.lastMs).toISOString() : null,
      active: agentIsActive({ lastMs: a.lastMs, sampleAgeMs, now }),
      liveSample: sampleAgeMs != null && sampleAgeMs < SAMPLE_FRESH_MS,
      model: sample?.model ?? null,
      costUsd: sample?.costUsd ?? null,
      ctxPct: sample?.ctxPct ?? null,
      effort: sample?.effort ?? null,
      latestSessionId: a.latest,
      isOwn: Boolean(ownSessionId && a.latest === ownSessionId),
      tasks: readTaskGroup(tasksRoot, a.latest),
      recentSessions: (a.recent ?? []).map((f) => ({
        id: f.id,
        lastActivity: new Date(f.mtimeMs).toISOString(),
      })),
      // Overlaid downstream (event projection + policy adapter); declared here
      // so the agent shape is stable for the UI and checkJs.
      eventState: /** @type {string|null} */ (null),
      workflow: /** @type {string|null} */ (null),
      readOnly: /** @type {boolean|null} */ (null),
      approvalRequired: /** @type {boolean|null} */ (null),
      policyState: /** @type {string|null} */ (null),
      policyRevision: /** @type {number|null} */ (null),
      rejected: false,
    });
  }
  agents.sort((x, y) =>
    String(y.lastActivity || "").localeCompare(String(x.lastActivity || "")),
  );
  return {
    total: agents.reduce((n, a) => n + a.sessionCount, 0),
    activeCount: agents.filter((a) => a.active).length,
    agents,
  };
}
