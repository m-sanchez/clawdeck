// @ts-check
/**
 * Session-trace adapter: turn segmentation, span pairing, usage dedup,
 * liveness semantics, bounded backward read. Run: node --test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionTrace } from "../server/adapters/session-trace.mjs";
import {
  writeTranscript,
  writeSubagentMeta,
  userMsg,
  assistantTool,
  toolResult,
  assistantEnd,
  latchRow,
  USAGE,
} from "./helpers/transcript-fixture.mjs";

let dir;
before(() => (dir = mkdtempSync(join(tmpdir(), "clawdeck-trace-"))));
after(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse("2026-08-31T10:00:00.000Z");
const s = (n) => T0 + n * 1000;

test("segments turns on end_turn; spans pair with durations", () => {
  const path = writeTranscript(dir, "aaaa1111", [
    userMsg(s(0), "first question"),
    assistantTool(
      s(1),
      "req1",
      "tu1",
      "Bash",
      { command: "ls -la" },
      USAGE(100, 20),
    ),
    toolResult(s(4), "tu1", "files"),
    assistantEnd(s(5), "req1b", USAGE(50, 30)),
    userMsg(s(60), "second question"),
    assistantTool(
      s(61),
      "req2",
      "tu2",
      "Read",
      { file_path: "a/b.txt" },
      USAGE(10, 5),
    ),
    toolResult(s(63), "tu2", "content"),
    assistantEnd(s(64), "req2b", USAGE(5, 2)),
  ]);
  const r = getSessionTrace(path);
  assert.equal(r.turns.length, 2);
  const [t1, t2] = r.turns;
  assert.equal(t1.spans.length, 1);
  assert.equal(t1.spans[0].tool, "Bash");
  assert.equal(t1.spans[0].durMs, 3000);
  assert.equal(t1.spans[0].ok, true);
  assert.equal(t1.durMs, 5000);
  assert.equal(t1.open, false);
  assert.equal(t2.gapBeforeMs, 55000);
  assert.equal(r.model, "claude-test-1");
  assert.equal(r.truncated, false);
});

test("usage dedupes by requestId; distinct requests both count", () => {
  const dup = assistantTool(
    s(1),
    "reqX",
    "tuX",
    "Bash",
    { command: "x" },
    USAGE(100, 40),
  );
  const path = writeTranscript(dir, "aaaa2222", [
    userMsg(s(0), "q"),
    dup,
    { ...dup, timestamp: new Date(s(2)).toISOString() }, // same requestId, identical usage
    toolResult(s(3), "tuX", "ok"),
    assistantEnd(s(4), "reqY", USAGE(10, 5)),
  ]);
  const r = getSessionTrace(path);
  assert.equal(r.turns.length, 1);
  assert.deepEqual(r.turns[0].usage, {
    input: 110,
    output: 45,
    cacheRead: 0,
    cacheCreate: 0,
    requests: 2,
  });
});

test("interrupted turn closes at the next prompt", () => {
  const path = writeTranscript(dir, "aaaa3333", [
    userMsg(s(0), "q1"),
    assistantTool(s(1), "r1", "tu1", "Bash", { command: "sleep" }, USAGE(1, 1)),
    userMsg(s(30), "q2 (user interrupted)"),
    assistantEnd(s(31), "r2", USAGE(2, 2)),
  ]);
  const r = getSessionTrace(path, { sessionLive: false });
  assert.equal(r.turns.length, 2);
  assert.equal(r.turns[0].open, false);
  assert.equal(r.turns[0].spans[0].incomplete, true);
  assert.equal(r.turns[0].spans[0].durMs, null);
  assert.equal(r.turns[0].spans[0].running, false);
});

test("open turn: running clamps to now only when session is live", () => {
  const records = [
    userMsg(s(0), "q"),
    assistantTool(s(1), "r1", "tu1", "Bash", { command: "build" }, USAGE(1, 1)),
  ];
  const now = s(600);
  const live = getSessionTrace(writeTranscript(dir, "aaaa4444", records), {
    now,
    sessionLive: true,
  });
  assert.equal(live.turns[0].open, true);
  assert.equal(live.turns[0].spans[0].running, true);
  assert.equal(live.turns[0].spans[0].durMs, 599000);
  assert.equal(live.turns[0].durMs, 600000);

  const dead = getSessionTrace(writeTranscript(dir, "aaaa5555", records), {
    now,
    sessionLive: false,
  });
  assert.equal(dead.turns[0].open, true);
  assert.equal(dead.turns[0].spans[0].running, false);
  assert.equal(dead.turns[0].spans[0].incomplete, true);
  assert.equal(dead.turns[0].spans[0].durMs, null);
  assert.equal(dead.turns[0].durMs, null);
});

test("latch rows and unknown types are skipped", () => {
  const path = writeTranscript(dir, "aaaa6666", [
    latchRow("last-prompt"),
    latchRow("custom-title"),
    latchRow("mode"),
    latchRow("pr-link"),
    latchRow("bridge-session"),
    userMsg(s(0), "q"),
    latchRow("queue-operation"),
    assistantEnd(s(1), "r1", USAGE(1, 1)),
  ]);
  const r = getSessionTrace(path);
  assert.equal(r.turns.length, 1);
});

test("out-of-order timestamps sort; equal timestamps keep line order", () => {
  const path = writeTranscript(dir, "aaaa7777", [
    userMsg(s(0), "q"),
    // result line written BEFORE the use line but with a later timestamp
    toolResult(s(3), "tuZ", "out"),
    assistantTool(s(1), "r1", "tuZ", "Grep", { pattern: "x" }, USAGE(1, 1)),
    assistantEnd(s(4), "r2", USAGE(1, 1)),
  ]);
  const r = getSessionTrace(path);
  assert.equal(r.turns[0].spans[0].durMs, 2000);
});

test("maxTurns keeps the newest turns and flags truncation", () => {
  const records = [];
  for (let i = 0; i < 6; i++) {
    records.push(userMsg(s(i * 10), `q${i}`));
    records.push(assistantEnd(s(i * 10 + 1), `r${i}`, USAGE(1, 1)));
  }
  const r = getSessionTrace(writeTranscript(dir, "aaaa8888", records), {
    maxTurns: 2,
  });
  assert.equal(r.turns.length, 2);
  assert.equal(r.truncated, true);
  assert.equal(r.turns[0].index, 0);
  assert.equal(r.turns[1].index, 1);
});

test("byte budget drops the cut-off oldest turn, never mis-assembles it", () => {
  const big = "x".repeat(2000);
  const records = [];
  for (let i = 0; i < 200; i++) {
    records.push(userMsg(s(i * 10), `q${i} ${big}`));
    records.push(
      assistantTool(
        s(i * 10 + 1),
        `r${i}`,
        `tu${i}`,
        "Bash",
        { command: big },
        USAGE(1, 1),
      ),
    );
    records.push(toolResult(s(i * 10 + 2), `tu${i}`, big));
    records.push(assistantEnd(s(i * 10 + 3), `r${i}b`, USAGE(1, 1)));
  }
  const path = writeTranscript(dir, "aaaa9999", records);
  const r = getSessionTrace(path, { maxTurns: 50, maxTailBytes: 64 * 1024 });
  assert.equal(r.truncated, true);
  assert.ok(r.turns.length >= 1);
  // Every emitted turn is complete: starts at a prompt and pairs its span.
  for (const t of r.turns) {
    assert.equal(t.spans.length, 1);
    assert.equal(t.spans[0].durMs, 1000);
    assert.equal(t.open, false);
  }
});

test("subagent meta attaches to Task spans via toolUseId", () => {
  const path = writeTranscript(dir, "bbbb1111", [
    userMsg(s(0), "q"),
    assistantTool(
      s(1),
      "r1",
      "task1",
      "Task",
      { description: "explore stuff" },
      USAGE(1, 1),
    ),
    toolResult(s(9), "task1", "done"),
    assistantEnd(s(10), "r2", USAGE(1, 1)),
  ]);
  writeSubagentMeta(dir, "bbbb1111", "abc123", {
    agentType: "Explore",
    description: "explore stuff",
    toolUseId: "task1",
    spawnDepth: 1,
  });
  const r = getSessionTrace(path);
  const span = r.turns[0].spans[0];
  assert.equal(span.isTask, true);
  assert.deepEqual(span.agent, {
    agentType: "Explore",
    description: "explore stuff",
  });
});

test("wait tools are flagged", () => {
  const path = writeTranscript(dir, "bbbb2222", [
    userMsg(s(0), "q"),
    assistantTool(s(1), "r1", "tuW", "ExitPlanMode", {}, USAGE(1, 1)),
    toolResult(s(500), "tuW", "approved"),
    assistantEnd(s(501), "r2", USAGE(1, 1)),
  ]);
  const r = getSessionTrace(path);
  assert.equal(r.turns[0].spans[0].wait, true);
  assert.equal(r.turns[0].spans[0].durMs, 499000);
});

test("missing file reports missing", () => {
  const r = getSessionTrace(join(dir, "nope.jsonl"));
  assert.equal(r.missing, true);
  assert.deepEqual(r.turns, []);
});

test("failed tool result marks ok:false", () => {
  const path = writeTranscript(dir, "bbbb3333", [
    userMsg(s(0), "q"),
    assistantTool(s(1), "r1", "tuF", "Bash", { command: "bad" }, USAGE(1, 1)),
    toolResult(s(2), "tuF", "boom", true),
    assistantEnd(s(3), "r2", USAGE(1, 1)),
  ]);
  const r = getSessionTrace(path);
  assert.equal(r.turns[0].spans[0].ok, false);
});
