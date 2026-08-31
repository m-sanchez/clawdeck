// @ts-check
/**
 * Session feed: reconstruct a Claude Code session's recent transcript into an
 * ordered list of render-ready events (user prompts, assistant text, thinking,
 * tool calls with their results), so the panel can mirror what the CLI shows.
 *
 * Read-only and bounded: only the TAIL of the (often multi-MB) `*.jsonl` is read,
 * the first partial line is dropped, and previews are ANSI-stripped and truncated.
 */
import { openSync, fstatSync, readSync, closeSync } from "node:fs";

const TAIL_BYTES = 300000;
const TEXT_CAP = 600;
const THINK_CAP = 280;
const PREVIEW_CAP = 220;
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

function stripAnsi(s) {
  const cleaned = String(s || "").replace(ANSI, "");
  let out = "";
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned.charCodeAt(i);
    // Drop C0 control chars (incl. a bare ESC the ANSI pass left behind) but keep
    // tab (9) and newline (10).
    if (c < 32 && c !== 9 && c !== 10) continue;
    out += cleaned[i];
  }
  return out;
}

function clip(s, n) {
  const t = stripAnsi(s).replace(/\s+$/, "");
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** Last two path segments, so a long absolute file path reads like the CLI. */
function shortPath(p) {
  const parts = String(p || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  return parts.slice(-2).join("/") || String(p || "");
}

/** One-line argument summary for a tool call, matching the CLI's `Tool(arg)`. */
function summarizeTool(name, input) {
  const i = input || {};
  switch (name) {
    case "Bash":
      return clip(String(i.command || "").split(/\r?\n/)[0], 120);
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return shortPath(i.file_path || i.notebook_path);
    case "Grep":
      return clip(i.pattern || "", 80);
    case "Glob":
      return clip(i.pattern || "", 80);
    case "TodoWrite":
      return `${(i.todos || []).length} todos`;
    case "Task":
    case "Agent":
      return clip(i.description || i.subagent_type || "", 80);
    case "Skill":
      return clip(i.skill || "", 60);
    case "Workflow":
      return clip(i.name || "inline", 60);
    default: {
      const first = Object.values(i).find((v) => typeof v === "string");
      return clip(first || "", 80);
    }
  }
}

function resultText(block) {
  const c = block?.content;
  if (Array.isArray(c)) return c.map((x) => x?.text || "").join("");
  return String(c ?? "");
}

/**
 * @param {string} transcriptPath
 * @param {{ limit?: number }} [opts]
 * @returns {{ events: Array<object>, missing?: boolean, branch?: string, model?: string }}
 */
export function getSessionFeed(transcriptPath, opts = {}) {
  const limit = opts.limit || 60;
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return { events: [], missing: true };
  }
  let text;
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }

  const lines = text.split(/\r?\n/);
  // Drop the first line: when we tail mid-file it is almost always a partial record.
  lines.shift();

  /** @type {Array<object>} */
  const events = [];
  const toolById = new Map();
  let branch = "";
  let model = "";

  for (const line of lines) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = o.timestamp || null;
    if (o.gitBranch) branch = o.gitBranch;
    const blocks = o.message?.content;

    if (o.type === "assistant" && Array.isArray(blocks)) {
      if (o.message?.model) model = o.message.model;
      for (const b of blocks) {
        if (b.type === "thinking") {
          events.push({
            kind: "thinking",
            ts,
            text: clip(b.thinking || b.text, THINK_CAP),
          });
        } else if (b.type === "text") {
          const t = clip(b.text, TEXT_CAP);
          if (t) events.push({ kind: "assistant", ts, text: t });
        } else if (b.type === "tool_use") {
          const e = {
            kind: "tool",
            ts,
            tool: b.name || "tool",
            summary: summarizeTool(b.name, b.input),
            result: null,
          };
          if (b.id) toolById.set(b.id, e);
          events.push(e);
        }
      }
    } else if (o.type === "user") {
      if (typeof blocks === "string") {
        const t = clip(blocks, TEXT_CAP);
        if (t) events.push({ kind: "user", ts, text: t });
      } else if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b.type !== "tool_result") continue;
          const raw = resultText(b);
          const res = {
            ok: !b.is_error,
            preview: clip(raw, PREVIEW_CAP),
            lines: stripAnsi(raw).split(/\r?\n/).filter(Boolean).length,
          };
          const prev = toolById.get(b.tool_use_id);
          if (prev) prev.result = res;
          else events.push({ kind: "result", ts, ...res });
        }
      }
    }
  }

  return { events: events.slice(-limit), branch, model };
}
