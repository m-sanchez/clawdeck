// @ts-check
/** Unit tests for the shared event normalizer (redaction is load-bearing). */
import { test } from "node:test";
import assert from "node:assert/strict";
import normalize from "../hooks/lib/event-normalize.cjs";

const { normalizeEvent, EVENT_MAP } = normalize;

test("maps hook_event_name to the normalized event name", () => {
  const e = normalizeEvent(
    { hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "s1" },
    { id: "x", ts: 1 },
  );
  assert.equal(e.event, "tool.pre");
  assert.equal(e.session_id, "s1");
  assert.equal(e.data.tool, "Bash");
  assert.equal(EVENT_MAP.SessionStart, "session.start");
});

test("REDACTION: raw prompt text never enters the event; only its length", () => {
  const secret = "super secret prompt text";
  const e = normalizeEvent(
    { hook_event_name: "UserPromptSubmit", prompt: secret, session_id: "s1" },
    { id: "x", ts: 1 },
  );
  assert.equal(e.data.promptLen, secret.length);
  assert.ok(!JSON.stringify(e).includes("super secret"));
});

test("REDACTION: tool input/output content never enters the event", () => {
  const e = normalizeEvent(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat /etc/secret" },
      tool_response: { success: true, output: "leaked-value" },
      session_id: "s1",
    },
    { id: "x", ts: 1 },
  );
  assert.equal(e.data.tool, "Bash");
  assert.equal(e.data.ok, true);
  const json = JSON.stringify(e);
  assert.ok(!json.includes("/etc/secret"));
  assert.ok(!json.includes("leaked-value"));
});

test("promotes agent_id/agent_type; unknown hook falls back to hook.<name>", () => {
  const e = normalizeEvent(
    {
      hook_event_name: "SubagentStart",
      agent_id: "a1",
      agent_type: "Explore",
      session_id: "s1",
    },
    { id: "x", ts: 1 },
  );
  assert.equal(e.agent_id, "a1");
  assert.equal(e.agent_type, "Explore");
  assert.equal(e.data.agentType, "Explore");

  const u = normalizeEvent(
    { hook_event_name: "SomethingNew", session_id: "s1" },
    { id: "x", ts: 1 },
  );
  assert.equal(u.event, "hook.somethingnew");
});
