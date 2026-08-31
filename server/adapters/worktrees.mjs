// @ts-check
/**
 * Worktrees adapter. The authoritative list comes from `git worktree list`
 * (always available); the central `.claude/.wt-registry/` enriches each entry
 * with its reserved slot, deterministic ports, data mode and owned-process
 * liveness when present. Panel instances are detected from each worktree's own
 * runtime registry. Everything degrades gracefully when the harness is absent.
 *
 * @typedef {import('../../../contracts/panel-protocol').WorktreeSummary} WorktreeSummary
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../lib/git.mjs";
import { loadEsm } from "../lib/repo-modules.mjs";
import { isPortAvailable } from "../../scripts/lib/ports.mjs";
import { isProcessAlive } from "../../scripts/lib/processes.mjs";

function norm(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Parse `git worktree list --porcelain` into structured records. */
function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = {
        path: line.slice("worktree ".length),
        branch: null,
        head: null,
        detached: false,
        locked: false,
      };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).slice(0, 9);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "detached") {
      cur.detached = true;
    } else if (line.startsWith("locked")) {
      cur.locked = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function isListening(port) {
  if (!port) return false;
  return !(await isPortAvailable(port));
}

// Per-worktree churn cache: path -> { dirty, lastChange, ts }. Filled by a
// throttled, concurrency-bounded background pass (refreshChurn) so a snapshot
// never blocks on ~2 git spawns per worktree. The snapshot reads cached values;
// fresh ones land on the next refresh tick.
/** @type {Map<string, { dirty: number, lastChange: string|null, ts: number }>} */
const churnCache = new Map();
let churnRefreshing = false;
let churnRefreshedAt = 0;
const CHURN_TTL_MS = 12000;
const CHURN_CONCURRENCY = 4;

async function refreshChurn(paths) {
  churnRefreshing = true;
  try {
    const queue = [...paths];
    const worker = async () => {
      for (;;) {
        const p = queue.shift();
        if (!p) return;
        const ds = await dirtyStats(p);
        churnCache.set(p, { ...ds, ts: Date.now() });
      }
    };
    await Promise.all(
      Array.from({ length: CHURN_CONCURRENCY }, () => worker()),
    );
    churnRefreshedAt = Date.now();
  } finally {
    churnRefreshing = false;
  }
}

/**
 * Uncommitted churn for one worktree: how many files differ from HEAD (tracked
 * changes + untracked) and when the newest of them was last written. The mtime is
 * the live "an agent is working here right now" signal the committed-history views
 * can't show. Two name-only git calls (no leading status column, so the trimmed
 * git() output parses cleanly) plus a bounded stat sweep for the newest mtime.
 * @returns {Promise<{ dirty: number, lastChange: string|null }>}
 */
async function dirtyStats(worktreePath) {
  const [tracked, untracked] = await Promise.all([
    git(["diff", "--name-only", "HEAD"], worktreePath),
    git(["ls-files", "--others", "--exclude-standard"], worktreePath),
  ]);
  const files = [];
  for (const block of [tracked, untracked]) {
    for (const line of String(block || "").split(/\r?\n/)) {
      const p = line.trim();
      if (p) files.push(p);
    }
  }
  if (!files.length) return { dirty: 0, lastChange: null };
  // Newest mtime among the changed files. Deleted/quoted-unusual paths simply
  // fail to stat and are skipped; the count still reflects every changed file.
  let newest = 0;
  await Promise.all(
    files.slice(0, 500).map(async (rel) => {
      try {
        const st = await stat(join(worktreePath, rel));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* deleted or inaccessible */
      }
    }),
  );
  return {
    dirty: files.length,
    lastChange: newest ? new Date(newest).toISOString() : null,
  };
}

/** Read a worktree's owned panel instances from its runtime registry. */
function readPanelInstances(worktreePath) {
  const base = join(worktreePath, ".claude", ".runtime", "panel");
  if (!existsSync(base)) return [];
  const found = [];
  let ids = [];
  try {
    ids = readdirSync(base);
  } catch {
    return [];
  }
  for (const id of ids) {
    try {
      const reg = JSON.parse(
        readFileSync(join(base, id, "registry.json"), "utf8"),
      );
      for (const svc of reg.services ?? []) {
        found.push({
          id: `panel:${svc.id}`,
          pid: svc.pid,
          port: svc.port,
          url: svc.url,
          healthUrl: svc.healthUrl,
        });
      }
    } catch {
      /* no registry for this id */
    }
  }
  return found;
}

/**
 * @param {{ checkoutRoot: string, repoRoot: string }} ctx
 * @returns {Promise<WorktreeSummary[]>}
 */
export async function getWorktrees(ctx) {
  const porcelain = await git(
    ["worktree", "list", "--porcelain"],
    ctx.checkoutRoot,
  );
  if (!porcelain) return [];
  const trees = parseWorktrees(porcelain);

  // Central registry (lives under the main repo root). Best-effort.
  /** @type {Map<string, any>} */
  const byPath = new Map();
  let slotPorts = null;
  // Real PID liveness by default, so owned panel instances are classified
  // correctly even when the optional central worktree registry is absent. The
  // registry may override with its own equivalent below.
  let isPidAlive = isProcessAlive;
  const registry = await loadEsm(
    ctx.checkoutRoot,
    ".claude/scripts/worktree-registry.mjs",
  );
  if (registry?.listEntries && registry?.registryDirFor) {
    try {
      // ctx.repoRoot is the main checkout (PANEL_REPO_ROOT). Use it directly so we
      // never shell git per snapshot: the registry's detectMainRoot uses execSync
      // without windowsHide, which flashes a console window each refresh tick.
      const dir = registry.registryDirFor(ctx.repoRoot);
      for (const entry of registry.listEntries(dir)) {
        if (entry?.path) byPath.set(norm(entry.path), entry);
      }
      slotPorts = registry.portsForSlot ?? null;
      if (typeof registry.isPidAlive === "function")
        isPidAlive = registry.isPidAlive;
    } catch {
      /* registry unreadable, git-only view */
    }
  }

  const currentNorm = norm(ctx.checkoutRoot);
  const results = [];
  for (const tree of trees) {
    const entry = byPath.get(norm(tree.path));
    const ports =
      entry?.ports ??
      (entry?.slot != null && slotPorts ? slotPorts(entry.slot) : null);

    /** @type {WorktreeSummary['services']} */
    const services = [];
    if (ports) {
      const labels = [
        ["server", ports.server],
        ["mgmt-server", ports.mgmtServer],
        ["client", ports.client],
        ["mgmt-client", ports.mgmtClient],
      ];
      const liveness = await Promise.all(
        labels.map(([, port]) => isListening(port)),
      );
      labels.forEach(([id, port], i) => {
        services.push({
          id,
          status: liveness[i] ? "running" : "stopped",
          port,
          url:
            id === "client" || id === "mgmt-client"
              ? `http://127.0.0.1:${port}`
              : undefined,
        });
      });
    }

    for (const panel of readPanelInstances(tree.path)) {
      const alive = isPidAlive(panel.pid);
      services.push({
        id: panel.id,
        status: alive ? "running" : "stopped",
        pid: panel.pid,
        port: panel.port,
        url: panel.url,
      });
    }

    const pidActive = entry
      ? [
          ...(entry.procs ?? []).map((p) => p?.pid),
          ...(entry.supervisorPids ?? []),
        ]
          .filter(Boolean)
          .some(isPidAlive)
      : false;

    results.push({
      id:
        entry?.id ??
        tree.path.replace(/\\/g, "/").split("/").pop() ??
        tree.path,
      path: tree.path,
      branch: tree.branch ?? (tree.detached ? `(detached ${tree.head})` : ""),
      services,
      lastActivity: entry?.lastHealth
        ? new Date(entry.lastHealth).toISOString()
        : undefined,
      // Extra fields beyond the base contract, consumed by the UI:
      head: tree.head,
      detached: tree.detached,
      locked: tree.locked,
      isCurrent: norm(tree.path) === currentNorm,
      slot: entry?.slot ?? null,
      dataMode: entry?.dataMode ?? null,
      status: entry?.status ?? null,
      registered: Boolean(entry),
      processActive: pidActive,
      // Filled in by the merged/cleanup pass below.
      merged: false,
      cleanupCandidate: false,
      /** @type {string|null} */
      cleanupReason: null,
      /** @type {number|null} */
      ahead: null,
      /** @type {number|null} */
      behind: null,
      /** @type {{ subject: string, author: string, date: string }|null} */
      lastCommit: null,
      // Live uncommitted churn (filled in by the parallel pass below).
      dirty: 0,
      /** @type {string|null} */
      lastChange: null,
    });
  }

  // Per-worktree uncommitted churn, read from the cache (instant). This is the
  // live signal that an agent is actively writing in a worktree, which the
  // committed-history views miss.
  for (const w of results) {
    const c = churnCache.get(w.path);
    w.dirty = c ? c.dirty : 0;
    w.lastChange = c ? c.lastChange : null;
  }
  // Kick a throttled background refresh; never awaited, so the snapshot stays
  // fast even with dozens of worktrees. Fresh churn lands on the next snapshot.
  if (!churnRefreshing && Date.now() - churnRefreshedAt > CHURN_TTL_MS) {
    void refreshChurn(results.map((w) => w.path));
  }

  // One call: ahead/behind the default branch (git 2.41+ %(ahead-behind)) plus each
  // branch's last commit, so we never rev-list or git-log per worktree.
  /** @type {Map<string, { ahead: number, behind: number, subject: string, author: string, date: string }>} */
  const abMap = new Map();
  const abOut = await git(
    [
      "for-each-ref",
      "--format=%(refname:short)%00%(ahead-behind:origin/HEAD)%00%(subject)%00%(authorname)%00%(committerdate:iso-strict)",
      "refs/heads/",
    ],
    ctx.checkoutRoot,
  );
  if (abOut) {
    for (const line of abOut.split(/\r?\n/)) {
      const [branch, ab, subject, author, date] = line.split("\0");
      if (!branch || !ab) continue;
      const parts = ab.trim().split(/\s+/);
      const ahead = Number(parts[0]);
      const behind = Number(parts[1]);
      if (Number.isFinite(ahead) && Number.isFinite(behind))
        abMap.set(branch, {
          ahead,
          behind,
          subject: subject || "",
          author: author || "",
          date: date || "",
        });
    }
  }
  for (const w of results) {
    const ab = w.branch ? abMap.get(w.branch) : null;
    if (ab) {
      w.ahead = ab.ahead;
      w.behind = ab.behind;
      if (ab.subject || ab.author)
        w.lastCommit = {
          subject: ab.subject,
          author: ab.author,
          date: ab.date,
        };
    }
  }

  // One batched call: branches fully merged into the default branch (their tip is
  // an ancestor of origin/HEAD). Such a worktree's work is already integrated, so
  // it is a cleanup candidate (the authoritative safe removal stays with /wt-cleanup).
  const mergedOut = await git(
    ["branch", "--merged", "origin/HEAD", "--format=%(refname:short)"],
    ctx.checkoutRoot,
  );
  const mergedSet = new Set(
    mergedOut
      ? mergedOut
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  );
  for (const w of results) {
    w.merged = Boolean(w.branch && mergedSet.has(w.branch));
    const hasRunning = (w.services ?? []).some((s) => s.status === "running");
    w.cleanupCandidate =
      w.merged &&
      !w.isCurrent &&
      !w.processActive &&
      !hasRunning &&
      !w.detached &&
      !w.locked;
    w.cleanupReason = w.cleanupCandidate
      ? "merged into develop, idle"
      : w.merged
        ? "merged but busy (running/current)"
        : null;
  }

  // Current checkout first, then registered, then alphabetical.
  results.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.registered !== b.registered) return a.registered ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return results;
}
