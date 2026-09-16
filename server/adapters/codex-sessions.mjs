// @ts-check
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { codexState, parseJsonLines } from "./codex-transcript.mjs";

const MAX_FILES = 5000;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 300000;
const entries = new Map();
let listing = { root: "", at: 0, files: [] };

export function codexHome() {
  return resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
}

export function sessionPathKey(path) {
  const key = String(path || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function filesIn(root) {
  const now = Date.now();
  if (listing.root === root && now - listing.at < 4000) return listing.files;
  const files = [];
  const visit = (dir, depth) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of names) {
      if (files.length >= MAX_FILES) break;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name))
        visit(path, depth + 1);
      else if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name))
        files.push(path);
    }
  };
  visit(root, 0);
  listing = { root, at: now, files };
  const keep = new Set(files);
  for (const path of entries.keys()) if (!keep.has(path)) entries.delete(path);
  return files;
}

function readPart(path, bytes, tail = false) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const offset = tail ? size - length : 0;
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, offset);
    let text = buffer.toString("utf8", 0, read);
    if (offset > 0) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    return text;
  } catch {
    return "";
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function inspectFile(path) {
  try {
    const stat = statSync(path);
    const cached = entries.get(path);
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size)
      return cached;
    const head = parseJsonLines(readPart(path, HEAD_BYTES));
    const meta = head.find((r) => r.type === "session_meta")?.payload;
    const id = meta?.id || meta?.session_id;
    if (
      !/^[0-9a-fA-F-]{8,64}$/.test(id || "") ||
      typeof meta?.cwd !== "string" ||
      !isAbsolute(meta.cwd)
    )
      return null;
    const model =
      cached?.state?.model ||
      head.find((r) => r.type === "turn_context")?.payload?.model ||
      null;
    const entry = {
      id,
      cwd: meta.cwd,
      branch: typeof meta.git?.branch === "string" ? meta.git.branch : null,
      path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      model,
      state: null,
    };
    entries.set(path, entry);
    return entry;
  } catch {
    return null;
  }
}

function matchingSessions(worktrees) {
  const byPath = [...worktrees].sort((a, b) => b.path.length - a.path.length);
  const sessions = [];
  for (const file of filesIn(join(codexHome(), "sessions"))) {
    const entry = inspectFile(file);
    if (!entry) continue;
    const cwd = sessionPathKey(entry.cwd);
    const worktree = byPath.find((w) => {
      const path = sessionPathKey(w.path);
      return cwd === path || cwd.startsWith(path + "/");
    });
    if (worktree) sessions.push({ entry, worktree });
  }
  return sessions;
}

export function getCodexSessions(
  worktrees,
  ownSessionId = process.env.CODEX_THREAD_ID,
) {
  const now = Date.now();
  const seen = new Set();
  return matchingSessions(worktrees)
    .sort((a, b) => b.entry.mtimeMs - a.entry.mtimeMs)
    .flatMap(({ entry, worktree }) => {
      if (seen.has(entry.id)) return [];
      seen.add(entry.id);
      if (!entry.state)
        entry.state = codexState(
          parseJsonLines(readPart(entry.path, TAIL_BYTES, true)),
          entry.mtimeMs,
          entry.mtimeMs,
        );
      const fresh = now - Date.parse(entry.state.lastActivity) < 12 * 60 * 1000;
      return [
        {
          provider: "codex",
          branch: worktree.branch || entry.branch || "(detached)",
          path: worktree.path,
          isCurrent: Boolean(worktree.isCurrent),
          sessionCount: 1,
          ...entry.state,
          model: entry.state.model || entry.model,
          active: entry.state.active && fresh,
          eventState:
            entry.state.eventState === "running" && !fresh
              ? "stale"
              : entry.state.eventState,
          liveSample: false,
          costUsd: null,
          latestSessionId: entry.id,
          isOwn: entry.id === ownSessionId,
          tasks: null,
          recentSessions: [
            { id: entry.id, lastActivity: entry.state.lastActivity },
          ],
          workflow: null,
          readOnly: null,
          approvalRequired: null,
          policyState: null,
          policyRevision: null,
          rejected: false,
        },
      ];
    });
}

export function resolveCodexTranscript(sessionId, basePath) {
  const match = matchingSessions([{ path: basePath }]).find(
    ({ entry }) => entry.id === sessionId,
  );
  if (!match) return null;
  try {
    const root = realpathSync(join(codexHome(), "sessions"));
    const path = realpathSync(match.entry.path);
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
      return null;
    return path;
  } catch {
    return null;
  }
}

export function codexSessionIsLive(path) {
  try {
    return codexState(
      parseJsonLines(readPart(path, TAIL_BYTES, true)),
      statSync(path).mtimeMs,
    ).active;
  } catch {
    return false;
  }
}
