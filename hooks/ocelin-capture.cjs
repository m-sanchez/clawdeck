const {
  mkdirSync,
  writeFileSync,
  renameSync,
  readdirSync,
} = require("node:fs");
const { join, isAbsolute } = require("node:path");
const { randomUUID } = require("node:crypto");

const [provider, dataDir] = process.argv.slice(2);
let input = "";
const timeout = setTimeout(() => process.exit(0), 1500);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(0);
});
process.stdin.on("error", () => process.exit(0));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const p = JSON.parse(input);
    if (
      !["codex", "claude"].includes(provider) ||
      !isAbsolute(dataDir) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(p.session_id || "") ||
      !isAbsolute(p.cwd || "")
    )
      return;
    const map = {
      SessionStart: "idle",
      UserPromptSubmit: "start",
      PreToolUse: "tool",
      PostToolUse: "running",
      PermissionRequest: "attention",
      Stop: "complete",
      StopFailure: "error",
      Interrupt: "interrupt",
      SessionEnd: "end",
    };
    let kind = map[p.hook_event_name];
    let reason = "permission";
    if (
      p.hook_event_name === "PreToolUse" &&
      /(?:AskUserQuestion|request_user_input)$/.test(p.tool_name || "")
    ) {
      kind = "attention";
      reason = "question";
    }
    if (
      p.hook_event_name === "Notification" &&
      p.notification_type === "permission_prompt"
    )
      kind = "attention";
    if (!kind) return;
    const event = {
      id: randomUUID(),
      ts: Date.now(),
      provider,
      sessionId: p.session_id,
      cwd: p.cwd.slice(0, 4096),
      kind,
      reason,
      evidence: "hook",
    };
    if (/^[a-zA-Z0-9_-]{1,128}$/.test(p.turn_id || ""))
      event.turnId = p.turn_id;
    const dir = join(dataDir, "events");
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length >= 10000) return;
    const file = join(dir, event.id);
    writeFileSync(`${file}.tmp`, JSON.stringify(event), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(`${file}.tmp`, `${file}.json`);
  } catch {}
});
