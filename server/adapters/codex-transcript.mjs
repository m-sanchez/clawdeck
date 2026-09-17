// @ts-check
export function parseJsonLines(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    try {
      const record = JSON.parse(line);
      return record && typeof record === "object" && !Array.isArray(record)
        ? [record]
        : [];
    } catch {
      return [];
    }
  });
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => b?.text || "")
    .filter(Boolean)
    .join("\n");
}

function toolInput(p) {
  const raw = p.arguments ?? p.input;
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { input: raw || "" };
  }
}

function toolOutput(p) {
  const raw = p.output;
  const text = typeof raw === "string" ? raw : textContent(raw);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = raw;
  }
  const code = value?.metadata?.exit_code ?? value?.exit_code;
  const exit = text.match(/(?:Process exited with code|Exit code:)\s*(-?\d+)/i);
  return {
    type: "tool_result",
    tool_use_id: p.call_id,
    content: typeof value?.output === "string" ? value.output : text,
    is_error:
      p.is_error === true ||
      (code != null && code !== 0) ||
      (exit != null && Number(exit[1]) !== 0),
  };
}

export function normalizeCodexRecords(records) {
  const out = [];
  const hasStarts = records.some(
    (r) => r.type === "event_msg" && r.payload?.type === "task_started",
  );
  const hasEnds = records.some(
    (r) =>
      r.type === "event_msg" &&
      ["task_complete", "task_completed", "turn_aborted"].includes(
        r.payload?.type,
      ),
  );
  const hasUsage = records.some((r) => r.type === "token_usage_record");
  const hasUserItems = records.some(
    (r) => r.type === "response_item" && r.payload?.role === "user",
  );
  let model = null;
  let previousUsage = null;
  for (const r of records) {
    const p = r.payload;
    if (!p || typeof p !== "object") continue;
    const timestamp = r.timestamp;
    const assistant = (message, extra = {}) =>
      out.push({
        type: "assistant",
        timestamp,
        message: { role: "assistant", model, content: [], ...message },
        ...extra,
      });
    if (r.type === "turn_context")
      model = typeof p.model === "string" ? p.model : model;
    if (r.type === "event_msg") {
      if (p.type === "task_started") {
        out.push({
          type: "user",
          timestamp,
          message: { content: "Turn started" },
          omitFromFeed: true,
        });
      } else if (
        ["task_complete", "task_completed", "turn_aborted"].includes(p.type)
      ) {
        assistant({ stop_reason: "end_turn" });
      } else if (p.type === "user_message" && !hasUserItems) {
        out.push({
          type: "user",
          timestamp,
          isMeta: hasStarts,
          message: { content: p.message || "" },
        });
      }
    }
    if (
      r.type === "token_usage_record" ||
      (!hasUsage && r.type === "event_msg" && p.type === "token_count")
    ) {
      const total = p.info?.total_token_usage;
      let usage = p.usage;
      let key = p.response_id;
      if (total) {
        key = JSON.stringify(total);
        usage = previousUsage
          ? Object.fromEntries(
              Object.entries(total).map(([k, v]) => [
                k,
                Math.max(0, Number(v) - Number(previousUsage[k] || 0)),
              ]),
            )
          : p.info.last_token_usage;
        if (previousUsage && JSON.stringify(previousUsage) === key) continue;
        previousUsage = total;
      }
      if (usage && key)
        assistant(
          {
            usage: {
              input_tokens: Math.max(
                0,
                (usage.input_tokens || 0) - (usage.cached_input_tokens || 0),
              ),
              output_tokens: usage.output_tokens || 0,
              cache_read_input_tokens: usage.cached_input_tokens || 0,
              cache_creation_input_tokens: usage.cache_write_input_tokens || 0,
            },
          },
          { requestId: key },
        );
    }
    if (r.type !== "response_item") continue;
    if (p.type === "message") {
      const text = textContent(p.content);
      if (p.role === "user" && text)
        out.push({
          type: "user",
          timestamp,
          isMeta: hasStarts,
          message: { content: text },
        });
      if (p.role === "assistant")
        assistant({
          content: [{ type: "text", text }],
          ...(!hasEnds && ["final", "final_answer"].includes(p.phase)
            ? { stop_reason: "end_turn" }
            : {}),
        });
    } else if (["function_call", "custom_tool_call"].includes(p.type)) {
      assistant({
        content: [
          {
            type: "tool_use",
            id: p.call_id,
            name: p.name,
            input: toolInput(p),
          },
        ],
      });
    } else if (
      ["function_call_output", "custom_tool_call_output"].includes(p.type)
    ) {
      out.push({
        type: "user",
        timestamp,
        message: { content: [toolOutput(p)] },
      });
    } else if (p.type === "reasoning") {
      const text = textContent(p.summary);
      if (text) assistant({ content: [{ type: "thinking", text }] });
    }
  }
  return out;
}

export function codexState(records, mtimeMs, now = Date.now()) {
  let lastMs = mtimeMs;
  let state = null;
  let model = null;
  let effort = null;
  let ctxPct = null;
  for (const r of records) {
    // Windows can defer mtime updates while Codex keeps the rollout open.
    const timestamp = Date.parse(r.timestamp);
    if (Number.isFinite(timestamp)) lastMs = Math.max(lastMs, timestamp);
    const p = r.payload;
    if (!p) continue;
    if (r.type === "turn_context") {
      model = typeof p.model === "string" ? p.model : model;
      effort = typeof p.effort === "string" ? p.effort : effort;
    }
    if (r.type === "event_msg") {
      if (p.type === "task_started" || p.type === "user_message")
        state = "running";
      if (["task_complete", "task_completed", "turn_aborted"].includes(p.type))
        state = "idle";
      const info = p.info;
      if (
        p.type === "token_count" &&
        info?.model_context_window > 0 &&
        info.last_token_usage?.total_tokens != null
      ) {
        ctxPct = Math.min(
          100,
          Math.max(
            0,
            (100 * info.last_token_usage.total_tokens) /
              info.model_context_window,
          ),
        );
      }
    }
    if (r.type === "response_item") {
      if (p.type === "message" && p.role === "user") state = "running";
      if (["function_call", "custom_tool_call"].includes(p.type))
        state = "running";
      if (p.type === "message" && p.role === "assistant")
        state = ["final", "final_answer"].includes(p.phase)
          ? "idle"
          : "running";
    }
  }
  const fresh = lastMs > 0 && now - lastMs < 12 * 60 * 1000;
  return {
    active: fresh && state !== "idle",
    eventState: state === "running" && !fresh ? "stale" : state,
    model,
    effort,
    ctxPct,
    lastActivity: new Date(lastMs).toISOString(),
  };
}
