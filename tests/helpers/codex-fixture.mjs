import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CODEX_ID = "aaaaaaaa-1111-2222-3333-444444444444";
export const CODEX_OTHER_ID = "bbbbbbbb-1111-2222-3333-444444444444";
export const CODEX_T0 = Date.parse("2026-09-16T10:00:00Z");
export const codexRow = (seconds, type, payload) => ({
  timestamp: new Date(CODEX_T0 + seconds * 1000).toISOString(),
  type,
  payload,
});

export function codexTurn({ complete = true } = {}) {
  return [
    codexRow(0, "event_msg", { type: "task_started", turn_id: "turn-1" }),
    codexRow(0, "turn_context", { model: "codex-test", effort: "high" }),
    codexRow(0, "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Check the project" }],
    }),
    codexRow(0, "event_msg", {
      type: "user_message",
      message: "Check the project",
    }),
    codexRow(1, "response_item", {
      type: "function_call",
      call_id: "call-1",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "node --test" }),
    }),
    codexRow(3, "response_item", {
      type: "function_call_output",
      call_id: "call-1",
      output: "Process exited with code 0\nAll tests passed",
    }),
    codexRow(4, "token_usage_record", {
      response_id: "response-1",
      usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 15 },
    }),
    codexRow(4, "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 15,
        },
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 15,
          total_tokens: 115,
        },
        model_context_window: 1000,
      },
    }),
    ...(complete
      ? [
          codexRow(5, "response_item", {
            type: "message",
            role: "assistant",
            phase: "final",
            content: [{ type: "output_text", text: "Tests passed." }],
          }),
          codexRow(6, "event_msg", {
            type: "task_complete",
            turn_id: "turn-1",
          }),
        ]
      : []),
  ];
}

export function writeCodexRollout(
  home,
  cwd,
  rows = codexTurn(),
  id = CODEX_ID,
) {
  const dir = join(home, "sessions", "2026", "09", "16");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-09-16T10-00-00-${id}.jsonl`);
  const meta = codexRow(0, "session_meta", {
    id,
    cwd,
    source: "vscode",
    git: { branch: "codex/test" },
  });
  writeFileSync(
    file,
    [meta, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return file;
}
