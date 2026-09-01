// @ts-check
/**
 * Bind a task to the Claude session that actually ran it.
 *
 * The event spine cannot help here: `prompt.submit` carries `promptLen` and
 * never the text, and that redaction is load-bearing - weakening it so this
 * feature could read prompts would trade a real privacy property for a
 * convenience. So the marker is looked for where it legitimately exists: in the
 * session transcript, which Clawdeck already reads for the feed and the trace.
 *
 * A time window only says which transcripts are worth opening. The binding
 * itself needs the marker string to appear, so a session that merely started
 * nearby is never bound - which matters most when several tasks are launched at
 * once and every one of them has a plausible neighbour.
 */
import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { slugForPath } from "../../adapters/sessions.mjs";

const TAIL_BYTES = 256 * 1024;
const MAX_TRANSCRIPTS = 12;
/** Only transcripts touched this recently are worth opening. */
export const LOOKBACK_MS = 6 * 60 * 60 * 1000;

function tailText(path, bytes) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Candidate transcripts: the newest few across the checkout and its worktrees.
 * Candidacy is not evidence - it only bounds the search.
 */
export function candidateTranscripts(ctx, worktrees, opts = {}) {
  const now = opts.now ?? Date.now();
  const lookback = opts.lookbackMs ?? LOOKBACK_MS;
  const roots = [
    ctx.checkoutRoot,
    ...(worktrees || []).map((w) => w.path),
  ].filter(Boolean);
  const files = [];
  for (const root of new Set(roots)) {
    const dir = join(homedir(), ".claude", "projects", slugForPath(root));
    let names = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (now - st.mtimeMs > lookback) continue;
        files.push({
          path: full,
          sessionId: name.slice(0, -6),
          mtimeMs: st.mtimeMs,
        });
      } catch {
        /* unreadable: skip */
      }
    }
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, opts.maxTranscripts ?? MAX_TRANSCRIPTS);
}

/**
 * Which session, if any, contains each marker.
 * @returns {Map<string, string>} marker → sessionId
 */
export function findMarkers(markers, transcripts, opts = {}) {
  const wanted = [...new Set(markers)].filter(Boolean);
  const found = new Map();
  if (!wanted.length) return found;

  for (const t of transcripts) {
    const text = tailText(t.path, opts.tailBytes ?? TAIL_BYTES);
    if (!text) continue;
    for (const marker of wanted) {
      if (found.has(marker)) continue;
      if (text.includes(marker)) found.set(marker, t.sessionId);
    }
    if (found.size === wanted.length) break;
  }
  return found;
}
