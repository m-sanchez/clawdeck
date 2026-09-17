import { safeId } from "./model.mjs";

export function recordEvents(provider, record, context) {
  const ts = Date.parse(record.timestamp);
  const events = [];
  const emit = (kind, extra = {}) => {
    if (context.sessionId && Number.isFinite(ts))
      events.push({
        provider,
        sessionId: context.sessionId,
        cwd: context.cwd,
        parentId: context.parentId,
        id: `${context.sessionId}:${context.offset}:${kind}`,
        ts,
        kind,
        evidence: "inferred",
        ...extra,
      });
  };
  if (provider === "codex") {
    const p = record.payload || {};
    if (record.type === "session_meta") {
      if (safeId(p.id)) context.sessionId = p.id;
      if (typeof p.cwd === "string") context.cwd = p.cwd;
      context.parentId =
        p.parent_thread_id ||
        p.source?.subagent?.thread_spawn?.parent_thread_id ||
        null;
      emit("idle");
    }
    if (record.type === "event_msg") {
      if (p.type === "task_started") {
        context.turnId = p.turn_id;
        emit("start", { turnId: p.turn_id });
      }
      if (p.type === "user_message")
        emit("start", { turnId: p.turn_id || context.turnId });
      if (["task_complete", "task_completed"].includes(p.type))
        emit("complete", { turnId: p.turn_id });
      if (p.type === "turn_aborted") emit("interrupt", { turnId: p.turn_id });
    }
    if (record.type === "response_item") {
      if (["function_call", "custom_tool_call"].includes(p.type)) {
        emit(/request_user_input$/.test(p.name) ? "attention" : "tool", {
          reason: "question",
        });
      }
      if (["function_call_output", "custom_tool_call_output"].includes(p.type))
        emit("running");
      if (
        p.type === "message" &&
        p.role === "assistant" &&
        ["final", "final_answer"].includes(p.phase)
      )
        emit("complete");
    }
  } else {
    if (safeId(record.sessionId) && !context.subagent)
      context.sessionId = record.sessionId;
    if (typeof record.cwd === "string") context.cwd = record.cwd;
    const message = record.message || {};
    if (record.type === "user" && !record.isMeta) {
      const blocks = Array.isArray(message.content) ? message.content : [];
      emit(blocks.some((b) => b.type === "tool_result") ? "running" : "start");
    }
    if (record.type === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const tool = blocks.find((b) => b.type === "tool_use");
      if (tool)
        emit(tool.name === "AskUserQuestion" ? "attention" : "tool", {
          reason: "question",
        });
      else if (["end_turn", "stop_sequence"].includes(message.stop_reason))
        emit("complete");
      else emit("running");
    }
    if (record.type === "system" && record.subtype === "turn_duration")
      emit("complete");
  }
  return events;
}
