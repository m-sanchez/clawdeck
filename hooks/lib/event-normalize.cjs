"use strict";
/**
 * Normalize a Claude Code hook payload into a compact, REDACTED event envelope.
 * Shared by the emitter hook and the panel's tests so the wire shape has one
 * source of truth. The redaction is load-bearing: raw prompt text, assistant
 * text, and tool input/output must never enter the event store — only lengths,
 * names, and small enums. CommonJS so the CJS hook can require it directly.
 */

/** hook_event_name -> normalized event name. */
const EVENT_MAP = {
  SessionStart: "session.start",
  SessionEnd: "session.end",
  UserPromptSubmit: "prompt.submit",
  PreToolUse: "tool.pre",
  PostToolUse: "tool.post",
  SubagentStart: "subagent.start",
  SubagentStop: "subagent.stop",
  TaskCreated: "task.created",
  TaskCompleted: "task.completed",
  InstructionsLoaded: "instructions.loaded",
  PreCompact: "compact.pre",
  PostCompact: "compact.post",
  Notification: "notify",
  Stop: "stop",
  StopFailure: "stopfailure",
  CwdChanged: "cwd.changed",
  PermissionDenied: "permission.denied",
};

function truncate(s, n) {
  const str = String(s == null ? "" : s);
  return str.length > n ? str.slice(0, n) : str;
}

/**
 * Per-event redacted data. NEVER returns raw prompt/response/tool payloads —
 * only counts, names, and short enums.
 */
function redactData(hookName, p) {
  switch (hookName) {
    case "UserPromptSubmit":
      return {
        promptLen: typeof p.prompt === "string" ? p.prompt.length : null,
      };
    case "PreToolUse":
      return { tool: p.tool_name ?? null };
    case "PostToolUse":
      return {
        tool: p.tool_name ?? null,
        // Coerce to a strict boolean: a tool (esp. an MCP server) may return a
        // structured `success` object that would otherwise leak content.
        ok: p.tool_response == null ? null : Boolean(p.tool_response.success),
      };
    case "SubagentStart":
    case "SubagentStop":
      return {
        agentType: p.agent_type ?? null,
        // Actual subagent model when the payload provides it; the panel uses
        // this for attribution instead of assuming the parent's model.
        model: p.model?.id ?? p.model ?? p.model_id ?? null,
      };
    case "TaskCreated":
    case "TaskCompleted":
      // task_id is promoted to the envelope (normalizeEvent); completion is
      // signalled by the event TYPE (task.completed), not a status field.
      // task_subject, task_description, teammate_name, and team_name carry
      // user/team content and are never persisted.
      return {};
    case "InstructionsLoaded": {
      // The runtime event carries METADATA about a loaded instruction file, not
      // its content. Keep only privacy-safe metadata: the file path/identity,
      // memory type, load reason, and (when present) the matched globs plus the
      // trigger/parent file. There is NO content field, and the event supplies
      // no size, so bytes stay unknown (the baseline budget estimates size from
      // the filesystem instead).
      const globs = Array.isArray(p.globs)
        ? p.globs
            .filter((g) => typeof g === "string")
            .map((g) => truncate(g, 200))
        : null;
      return {
        file:
          typeof p.file_path === "string" ? truncate(p.file_path, 256) : null,
        memoryType: p.memory_type ?? null,
        loadReason: p.load_reason ?? null,
        globs,
        triggerFilePath:
          typeof p.trigger_file_path === "string"
            ? truncate(p.trigger_file_path, 256)
            : null,
        parentFilePath:
          typeof p.parent_file_path === "string"
            ? truncate(p.parent_file_path, 256)
            : null,
      };
    }
    case "PreCompact":
    case "PostCompact":
      return { trigger: p.trigger ?? null };
    case "Notification": {
      // Metadata only — never persist arbitrary notification text (it can carry
      // links/tokens/secrets). The panel shows the type + that a message
      // existed, not its content.
      const msg = typeof p.message === "string" ? p.message : "";
      return {
        notificationType: p.notification_type ?? p.type ?? null,
        hasMessage: msg.length > 0,
        messageLength: msg.length,
      };
    }
    case "PermissionDenied":
      return { tool: p.tool_name ?? null };
    case "SessionStart":
      return { source: p.source ?? null };
    case "StopFailure":
      return { reason: truncate(p.reason, 120) };
    default:
      return {};
  }
}

/**
 * @param {any} payload hook stdin JSON
 * @param {{ id:string, ts:number, seq?:number, hookName?:string }} meta
 */
function normalizeEvent(payload, meta) {
  const p = payload || {};
  const hookName = p.hook_event_name || meta.hookName || "Unknown";
  const event = EVENT_MAP[hookName] || "hook." + String(hookName).toLowerCase();
  const evt = {
    v: 1,
    id: meta.id,
    ts: meta.ts,
    event,
    session_id: p.session_id || null,
    cwd: p.cwd || p.workspace?.current_dir || null,
    data: redactData(hookName, p),
  };
  if (p.agent_id) evt.agent_id = p.agent_id;
  if (p.agent_type) evt.agent_type = p.agent_type;
  // Stable task identity (same value across TaskCreated + TaskCompleted) so the
  // projection can correlate a task's lifecycle, not just count events.
  if (p.task_id) evt.task_id = p.task_id;
  if (meta.seq != null) evt.seq = meta.seq;
  return evt;
}

module.exports = { EVENT_MAP, normalizeEvent, redactData, truncate };
