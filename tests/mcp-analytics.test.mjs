// @ts-check
/** MCP analytics: name parsing, aggregation, error/duration pairing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMcpName,
  accumulateTranscript,
} from "../server/adapters/mcp-analytics.mjs";

const iso = (t) => new Date(t).toISOString();
const T0 = Date.parse("2026-09-01T10:00:00Z");

const use = (t, id, name, input = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: iso(t),
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
const result = (t, id, isError = false) =>
  JSON.stringify({
    type: "user",
    timestamp: iso(t),
    message: {
      content: [{ type: "tool_result", tool_use_id: id, is_error: isError }],
    },
  });

test("parseMcpName handles double-underscore servers and rejects non-MCP", () => {
  assert.deepEqual(parseMcpName("mcp__github__create_issue"), {
    server: "github",
    tool: "create_issue",
  });
  assert.deepEqual(parseMcpName("mcp__plugin_a__b_server__take_screenshot"), {
    server: "plugin_a__b_server",
    tool: "take_screenshot",
  });
  assert.equal(parseMcpName("Bash"), null);
  assert.equal(parseMcpName("mcp__broken"), null);
});

test("aggregates calls, errors, durations and top tools per server", () => {
  const lines = [
    use(T0, "a", "mcp__browser__navigate"),
    result(T0 + 250, "a"),
    use(T0 + 1000, "b", "mcp__browser__screenshot"),
    result(T0 + 1900, "b"),
    use(T0 + 2000, "c", "mcp__browser__screenshot"),
    result(T0 + 2100, "c", true),
    use(T0 + 3000, "d", "mcp__figma__get_design"),
    result(T0 + 3600, "d"),
    use(T0 + 4000, "e", "Bash", { command: "ls" }),
    use(T0 + 5000, "f", "Skill", { skill: "code-review" }),
    use(T0 + 6000, "g", "Skill", { skill: "code-review" }),
  ];
  const servers = new Map();
  const skills = new Map();
  accumulateTranscript(lines, servers, skills);

  const browser = servers.get("browser");
  assert.equal(browser.calls, 3);
  assert.equal(browser.errors, 1);
  assert.deepEqual(
    [...browser.durations].sort((x, y) => x - y),
    [100, 250, 900],
  );
  assert.equal(browser.tools.get("screenshot"), 2);
  assert.equal(servers.get("figma").calls, 1);
  assert.ok(!servers.has("Bash"));
  assert.equal(skills.get("code-review"), 2);
});

test("unpaired MCP calls count without durations", () => {
  const servers = new Map();
  const skills = new Map();
  accumulateTranscript([use(T0, "x", "mcp__slow__thing")], servers, skills);
  const slow = servers.get("slow");
  assert.equal(slow.calls, 1);
  assert.equal(slow.durations.length, 0);
  assert.equal(slow.errors, 0);
});
