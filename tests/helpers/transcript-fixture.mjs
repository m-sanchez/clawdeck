// @ts-check
/** Builders for synthetic Claude Code transcript JSONL fixtures. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const iso = (t) => new Date(t).toISOString();

export function userMsg(ts, text, extra = {}) {
  return {
    type: "user",
    timestamp: iso(ts),
    message: { role: "user", content: text },
    ...extra,
  };
}

export function assistantTool(ts, requestId, toolUseId, name, input, usage) {
  return {
    type: "assistant",
    timestamp: iso(ts),
    requestId,
    message: {
      role: "assistant",
      model: "claude-test-1",
      id: `msg_${requestId}`,
      stop_reason: "tool_use",
      usage,
      content: [{ type: "tool_use", id: toolUseId, name, input }],
    },
  };
}

export function toolResult(ts, toolUseId, text, isError = false) {
  return {
    type: "user",
    timestamp: iso(ts),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: text,
          is_error: isError,
        },
      ],
    },
  };
}

export function assistantEnd(ts, requestId, usage, model = "claude-test-1") {
  return {
    type: "assistant",
    timestamp: iso(ts),
    requestId,
    message: {
      role: "assistant",
      model,
      id: `msg_${requestId}`,
      stop_reason: "end_turn",
      usage,
      content: [{ type: "text", text: "done" }],
    },
  };
}

export function latchRow(type) {
  return { type, value: "latch" };
}

export const USAGE = (input, output, cacheRead = 0, cacheCreate = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreate,
});

/** Write records as JSONL; returns the transcript path. */
export function writeTranscript(dir, sid, records) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sid}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

export function writeSubagentMeta(dir, sid, agentId, meta) {
  const sub = join(dir, sid, "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify(meta));
}
