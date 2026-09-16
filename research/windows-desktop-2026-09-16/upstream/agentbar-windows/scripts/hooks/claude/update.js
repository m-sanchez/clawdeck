#!/usr/bin/env node
// Claude Code hook -> ~/.agentbar/state.d/<session_id>.json
// Byte-for-byte the same state contract; only term_program detection is Windows-aware
// (this hook touches no OS-specific process APIs otherwise).
// Usage: node update.js <prompt|pre|post|stop>   (hook JSON on stdin)

const fs = require("fs");
const os = require("os");
const path = require("path");

const stateDir = path.join(os.homedir(), ".agentbar", "state.d");
const event = process.argv[2] || "";

const TOOL_LABELS = {
  Bash: "Running command", Edit: "Editing", Write: "Writing", MultiEdit: "Editing",
  NotebookEdit: "Editing", Read: "Reading", Grep: "Searching", Glob: "Searching",
  WebFetch: "Browsing web", WebSearch: "Searching web", Task: "Delegating",
  TodoWrite: "Planning",
};

const safeId = (s) => String(s || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "unknown";
const termProgram = (prev) =>
  process.env.WT_SESSION ? "WindowsTerminal" : (process.env.TERM_PROGRAM || prev.term_program || "");

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let p = {};
  try { p = JSON.parse(raw || "{}"); } catch {}

  const sid = safeId(p.session_id);
  const statePath = path.join(stateDir, sid + ".json");

  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}

  const cwd = p.cwd || prev.cwd || "";
  const project = cwd ? path.basename(cwd) : prev.project || "";
  const ts = Math.floor(Date.now() / 1000);
  let state = "idle", label = "";

  switch (event) {
    case "prompt": state = "thinking"; label = "Thinking…"; break;
    case "pre":    state = "tool"; label = TOOL_LABELS[p.tool_name] || "Using tool"; break;
    case "post":   state = "thinking"; label = "Thinking…"; break;
    case "stop":   state = "done"; label = ""; break;
    default: return;
  }

  const out = {
    agent: "claude",
    state, label,
    project, cwd,
    sessionId: p.session_id || "",
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || prev.entrypoint || "",
    term_program: termProgram(prev),
    pid: process.ppid, // the session's `claude` process; app prunes on its death
    started: true,
    ts,
  };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = statePath + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, statePath);
  } catch {}
});
