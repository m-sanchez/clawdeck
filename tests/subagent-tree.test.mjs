// @ts-check
/**
 * The subagent hierarchy. What matters here is restraint: an edge is only
 * emitted where a record proves it, the agent's own words are carried verbatim
 * rather than summarized, and a running agent is not reported as finished.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSubagentTree } from "../server/adapters/subagent-tree.mjs";

const SID = "de305d54-75b4-431b-adb2-eb6b9e546014";
let root = "";
let transcript = "";
let subagents = "";

const line = (o) => JSON.stringify(o) + "\n";

/** Write one agent's sidecar pair. */
function writeAgent(id, meta, records) {
  writeFileSync(join(subagents, `${id}.meta.json`), JSON.stringify(meta));
  writeFileSync(join(subagents, `${id}.jsonl`), records.map(line).join(""));
}

const userTurn = (ts, text) => ({
  type: "user",
  timestamp: ts,
  message: { role: "user", content: text },
});
const assistantEnd = (ts, text, extra = {}) => ({
  type: "assistant",
  timestamp: ts,
  message: {
    role: "assistant",
    model: "claude-test-1",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: {
      input_tokens: 10,
      output_tokens: 200,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 0,
    },
    ...extra,
  },
});

before(() => {
  root = mkdtempSync(join(tmpdir(), "clawdeck-subtree-"));
  transcript = join(root, `${SID}.jsonl`);
  subagents = join(root, SID, "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(transcript, line(userTurn("2026-09-01T10:00:00.000Z", "go")));

  // Depth 1: spawned by the session itself.
  writeAgent(
    "agent-aaa",
    {
      agentType: "Explore",
      description: "Map the adapters",
      toolUseId: "toolu_parent1",
      spawnDepth: 1,
    },
    [
      userTurn("2026-09-01T10:00:05.000Z", "map the adapters"),
      // A deeper agent is created from inside this one, so this transcript is
      // what proves the parent link below.
      {
        type: "assistant",
        timestamp: "2026-09-01T10:00:30.000Z",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_child9",
              name: "Task",
              input: { subagent_type: "Explore" },
            },
          ],
        },
      },
      assistantEnd(
        "2026-09-01T10:02:00.000Z",
        "Adapters mapped: twelve of them.",
      ),
    ],
  );

  // Depth 2: its parent must be discovered, not assumed.
  writeAgent(
    "agent-bbb",
    {
      agentType: "Explore",
      description: "Read one adapter",
      toolUseId: "toolu_child9",
      spawnDepth: 2,
    },
    [
      userTurn("2026-09-01T10:00:35.000Z", "read it"),
      assistantEnd(
        "2026-09-01T10:01:30.000Z",
        "It reads the spool and never writes.",
      ),
    ],
  );

  // Depth 2 whose creating Task appears in no transcript we hold.
  writeAgent(
    "agent-ccc",
    {
      agentType: "general-purpose",
      description: "Orphan",
      toolUseId: "toolu_missing",
      spawnDepth: 2,
    },
    [
      userTurn("2026-09-01T10:03:00.000Z", "work"),
      assistantEnd("2026-09-01T10:03:40.000Z", "Done."),
    ],
  );

  // Still running: no end_turn yet.
  writeAgent(
    "agent-ddd",
    {
      agentType: "Plan",
      description: "Still thinking",
      toolUseId: "toolu_parent2",
      spawnDepth: 1,
    },
    [
      userTurn("2026-09-01T10:04:00.000Z", "plan it"),
      {
        type: "assistant",
        timestamp: "2026-09-01T10:04:20.000Z",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [{ type: "text", text: "Working on it, partial thoughts." }],
        },
      },
    ],
  );
});

after(() => rmSync(root, { recursive: true, force: true }));

test("every agent in the sidecar directory is reported with its meta", () => {
  const tree = getSubagentTree(transcript);
  assert.equal(tree.agents.length, 4);
  const first = tree.agents.find((a) => a.id === "agent-aaa");
  assert.equal(first.agentType, "Explore");
  assert.equal(first.description, "Map the adapters");
  assert.equal(first.spawnDepth, 1);
  assert.equal(tree.maxDepth, 2);
});

test("a depth-1 agent is attributed to the session, without inventing a parent", () => {
  const tree = getSubagentTree(transcript);
  const top = tree.agents.find((a) => a.id === "agent-aaa");
  assert.equal(top.parentId, null);
  assert.equal(top.parentKnown, true);
  assert.ok(
    tree.edges.some(
      (e) =>
        e.from === "session" && e.to === "agent-aaa" && e.kind === "spawned",
    ),
  );
});

test("a nested agent is linked only to the transcript that contains its Task call", () => {
  const tree = getSubagentTree(transcript);
  const child = tree.agents.find((a) => a.id === "agent-bbb");
  assert.equal(child.parentId, "agent-aaa", "the Task id appears in agent-aaa");
  assert.equal(child.parentKnown, true);
  assert.ok(
    tree.edges.some((e) => e.from === "agent-aaa" && e.to === "agent-bbb"),
  );
});

test("an unprovable parent stays unknown and produces no edge", () => {
  const tree = getSubagentTree(transcript);
  const orphan = tree.agents.find((a) => a.id === "agent-ccc");
  assert.equal(orphan.parentKnown, false);
  assert.equal(orphan.parentId, null);
  assert.equal(
    tree.edges.some((e) => e.to === "agent-ccc"),
    false,
    "a missing record must not become a guessed edge",
  );
  assert.equal(tree.unknownParents, 1);
});

test("the closing message is the agent's own words, marked as such", () => {
  const tree = getSubagentTree(transcript);
  const done = tree.agents.find((a) => a.id === "agent-aaa");
  assert.equal(done.result.text, "Adapters mapped: twelve of them.");
  assert.equal(done.result.source, "actual agent message");
  assert.equal(done.result.closed, true);
});

test("a running agent is not reported as having concluded", () => {
  const tree = getSubagentTree(transcript);
  const running = tree.agents.find((a) => a.id === "agent-ddd");
  assert.equal(running.result, null, "mid-work narration is not a conclusion");
  assert.equal(running.durMs > 0, true);
});

test("durations and usage come from the records, never from guesses", () => {
  const tree = getSubagentTree(transcript);
  const child = tree.agents.find((a) => a.id === "agent-bbb");
  assert.equal(child.durMs, 55000);
  assert.deepEqual(child.usage, {
    input: 10,
    output: 200,
    cacheRead: 5000,
    cacheCreate: 0,
  });
  // The running agent's record carries no usage, so it contributes nothing:
  // three finished agents at 200 output each, not four.
  const running = tree.agents.find((a) => a.id === "agent-ddd");
  assert.equal(running.usage, null);
  assert.equal(tree.totals.output, 600);
});

test("a session with no subagents reports missing rather than an empty tree", () => {
  const bare = mkdtempSync(join(tmpdir(), "clawdeck-subtree-bare-"));
  try {
    const path = join(bare, "aaaaaaaa-0000-0000-0000-000000000000.jsonl");
    writeFileSync(path, "");
    const tree = getSubagentTree(path);
    assert.equal(tree.missing, true);
    assert.deepEqual(tree.agents, []);
    assert.deepEqual(tree.edges, []);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("the agent count is capped and the truncation is reported", () => {
  const tree = getSubagentTree(transcript, { maxAgents: 2 });
  assert.equal(tree.agents.length, 2);
  assert.equal(tree.truncated, true);
});
