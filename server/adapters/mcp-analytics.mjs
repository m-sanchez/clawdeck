// @ts-check
/**
 * MCP & skills analytics: which MCP servers and skills recent sessions
 * actually used, with call counts, error rates and durations - the evidence
 * for whether a server earns its context cost.
 *
 * Bounded IO: the newest few transcripts for the observed checkout (and its
 * worktrees), tail-read only, results cached briefly. Tool names arrive as
 * `mcp__<server>__<tool>`; `<server>` may itself contain `__` so the split
 * keeps everything between the first and last separators.
 */
import {
  openSync,
  fstatSync,
  readSync,
  closeSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { slugForPath } from "./sessions.mjs";

const TAIL_BYTES = 400000;
const MAX_TRANSCRIPTS = 8;
const CACHE_TTL_MS = 60000;

/** Parse `mcp__<server>__<tool>`; null for non-MCP tool names. */
export function parseMcpName(name) {
  const s = String(name || "");
  if (!s.startsWith("mcp__")) return null;
  const rest = s.slice(5);
  const cut = rest.lastIndexOf("__");
  if (cut <= 0) return null;
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
}

function tailLines(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (len < size) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

/**
 * Aggregate one transcript's MCP/skill usage into the accumulators.
 * Exported for tests.
 */
export function accumulateTranscript(lines, servers, skills) {
  const pending = new Map(); // tool_use id -> { entry, ts }
  for (const line of lines) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(o.timestamp || "") || null;
    const blocks = o.message?.content;
    if (!Array.isArray(blocks)) continue;
    if (o.type === "assistant") {
      for (const b of blocks) {
        if (b?.type !== "tool_use") continue;
        if (b.name === "Skill") {
          const skill = String(b.input?.skill || "").trim();
          if (skill) skills.set(skill, (skills.get(skill) || 0) + 1);
          continue;
        }
        const mcp = parseMcpName(b.name);
        if (!mcp) continue;
        let entry = servers.get(mcp.server);
        if (!entry)
          servers.set(
            mcp.server,
            (entry = {
              calls: 0,
              errors: 0,
              durations: [],
              tools: new Map(),
              lastUsed: null,
            }),
          );
        entry.calls++;
        entry.tools.set(mcp.tool, (entry.tools.get(mcp.tool) || 0) + 1);
        if (ts && (!entry.lastUsed || ts > entry.lastUsed)) entry.lastUsed = ts;
        if (b.id) pending.set(b.id, { entry, ts });
      }
    } else if (o.type === "user") {
      for (const b of blocks) {
        if (b?.type !== "tool_result") continue;
        const p = pending.get(b.tool_use_id);
        if (!p) continue;
        pending.delete(b.tool_use_id);
        if (b.is_error) p.entry.errors++;
        if (ts && p.ts && ts >= p.ts) p.entry.durations.push(ts - p.ts);
      }
    }
  }
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function project(servers, skills) {
  const out = [...servers.entries()]
    .map(([server, e]) => ({
      server,
      calls: e.calls,
      errors: e.errors,
      p50Ms: median(e.durations),
      maxMs: e.durations.length ? Math.max(...e.durations) : null,
      topTools: [...e.tools.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([tool, count]) => ({ tool, count })),
      lastUsed: e.lastUsed ? new Date(e.lastUsed).toISOString() : null,
    }))
    .sort((a, b) => b.calls - a.calls);
  const skillRows = [...skills.entries()]
    .map(([skill, count]) => ({ skill, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
  return { servers: out, skills: skillRows };
}

let cache = null;

/**
 * @param {{ checkoutRoot: string }} ctx
 * @param {Array<{ path: string }>} worktrees
 * @param {{ now?: number, force?: boolean }} [opts]
 */
export function getMcpAnalytics(ctx, worktrees, opts = {}) {
  const now = opts.now ?? Date.now();
  if (!opts.force && cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const roots = [
    ctx.checkoutRoot,
    ...(worktrees || []).map((w) => w.path),
  ].filter(Boolean);
  const files = [];
  for (const root of new Set(roots)) {
    const dir = join(homedir(), ".claude", "projects", slugForPath(root));
    let names;
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const n of names) {
      const full = join(dir, n);
      try {
        files.push({ full, mtime: statSync(full).mtimeMs });
      } catch {
        /* unreadable transcript: skip */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const picked = files.slice(0, MAX_TRANSCRIPTS);

  const servers = new Map();
  const skills = new Map();
  for (const f of picked)
    accumulateTranscript(tailLines(f.full), servers, skills);

  const value = {
    ...project(servers, skills),
    sessionsScanned: picked.length,
    computedAt: new Date(now).toISOString(),
  };
  cache = { at: now, value };
  return value;
}
