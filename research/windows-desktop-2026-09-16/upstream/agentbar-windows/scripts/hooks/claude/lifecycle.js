#!/usr/bin/env node
// Claude Code SessionStart/SessionEnd -> seed/remove this session's state file.
// Writes the same ~/.agentbar JSON contract; app liveness via tasklist and relaunch via
// the app-path marker (there's no launch-by-identity on Windows).
// Usage: node lifecycle.js <start|end>   (hook JSON on stdin)

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const EXEC = "AgentBar.exe";
const agentDir = path.join(os.homedir(), ".agentbar");
const stateDir = path.join(agentDir, "state.d");
const appPathFile = path.join(agentDir, "app-path"); // written by the app on first run
const event = process.argv[2];

const safeId = (s) => String(s || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "unknown";

// Liveness via tasklist; relaunch via the marker file the app records at startup.
const running = () => {
  try {
    const out = cp.execSync(`tasklist /FI "IMAGENAME eq ${EXEC}" /NH`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.toLowerCase().includes(EXEC.toLowerCase());
  } catch { return false; }
};
const launch = () => {
  try {
    const exe = fs.readFileSync(appPathFile, "utf8").trim();
    if (exe) cp.spawn(exe, [], { stdio: "ignore", detached: true, windowsHide: true }).unref();
  } catch { /* app not installed yet: nothing to launch */ }
};
// Windows Terminal exports WT_SESSION; classic consoles export neither, so keep it best-effort.
const termProgram = () => process.env.WT_SESSION ? "WindowsTerminal" : (process.env.TERM_PROGRAM || "");

const writeAtomic = (file, obj) => {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
};

let input = "", done = false;
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", run);
process.stdin.on("error", run);
setTimeout(run, 1000); // never hang the host session

function run() {
  if (done) return; done = true;
  fs.mkdirSync(stateDir, { recursive: true });
  let id = "", cwd = "";
  try { const j = JSON.parse(input); id = j.session_id; cwd = j.cwd || ""; } catch {}
  const statePath = path.join(stateDir, safeId(id) + ".json");

  if (event === "start") {
    const alive = running();
    // App not running -> leftover files are stale (prior crash); start honest.
    if (!alive) { try { for (const f of fs.readdirSync(stateDir)) fs.rmSync(path.join(stateDir, f), { force: true }); } catch {} }
    // started:false — a merely-opened conversation stays out of the popover until real
    // activity (update.js flips started on the first prompt/tool event).
    try {
      writeAtomic(statePath, {
        agent: "claude", state: "idle", label: "",
        project: cwd ? path.basename(cwd) : "", cwd, sessionId: id || "",
        entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || "",
        term_program: termProgram(),
        pid: process.ppid, started: false, ts: Math.floor(Date.now() / 1000),
      });
    } catch {}
    if (!alive) launch(); // idempotent: only start a second copy if none is running
  } else if (event === "end") {
    // Removing the file drops the session; also what recovers a frozen icon after a kill.
    try { fs.rmSync(statePath, { force: true }); } catch {}
  }
  process.exit(0);
}
