import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCodexSessions,
  resolveCodexTranscript,
} from "../server/adapters/codex-sessions.mjs";
import { getSessions } from "../server/adapters/sessions.mjs";
import { getSessionFeed } from "../server/adapters/session-feed.mjs";
import { getSessionTrace } from "../server/adapters/session-trace.mjs";
import { pickSession } from "../ui/lib/session-picker.mjs";
import {
  CODEX_ID,
  CODEX_OTHER_ID,
  CODEX_T0,
  codexRow,
  codexTurn,
  writeCodexRollout,
} from "./helpers/codex-fixture.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "clawdeck-codex-"));
  const home = join(dir, "codex");
  const checkout = join(dir, "project");
  const old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (old === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = old;
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    home,
    checkout,
    worktrees: [{ path: checkout, branch: "main", isCurrent: true }],
  };
}

test("discovers local Codex sessions, excludes other projects and marks completed turns idle", (t) => {
  const { home, checkout, worktrees } = fixture(t);
  writeCodexRollout(home, checkout);
  writeCodexRollout(home, checkout + "-other", codexTurn(), CODEX_OTHER_ID);
  const sessions = getSessions({ checkoutRoot: checkout }, worktrees);
  assert.equal(sessions.total, 1);
  assert.equal(sessions.activeCount, 0);
  const [agent] = sessions.agents;
  assert.equal(agent.provider, "codex");
  assert.equal(agent.latestSessionId, CODEX_ID);
  assert.equal(agent.eventState, "idle");
  assert.equal(agent.model, "codex-test");
  assert.equal(agent.costUsd, null);
  assert.equal(agent.ctxPct, 11.5);
  assert.equal(resolveCodexTranscript(CODEX_OTHER_ID, checkout), null);
  assert.ok(resolveCodexTranscript(CODEX_ID, checkout));
  assert.equal(JSON.stringify(sessions).includes("Check the project"), false);
});

test("tracks concurrent sessions in subdirectories and git worktrees, including plain checkouts", (t) => {
  const { home, checkout, worktrees } = fixture(t);
  writeCodexRollout(
    home,
    join(checkout, "src"),
    codexTurn({ complete: false }),
  );
  const worktree = {
    path: join(checkout, "nested-worktree"),
    branch: "feature",
  };
  writeCodexRollout(
    home,
    worktree.path,
    codexTurn({ complete: false }),
    CODEX_OTHER_ID,
  );
  const agents = getCodexSessions([...worktrees, worktree], CODEX_ID);
  assert.equal(agents.length, 2);
  assert.equal(agents.filter((a) => a.active).length, 2);
  assert.equal(
    agents.find((a) => a.latestSessionId === CODEX_OTHER_ID).path,
    worktree.path,
  );
  assert.equal(agents.find((a) => a.latestSessionId === CODEX_ID).isOwn, true);
  assert.equal(getSessions({ checkoutRoot: checkout }, []).total, 2);
});

test("re-reads growing rollouts and expires liveness even when cached", (t) => {
  const { home, checkout, worktrees } = fixture(t);
  const file = writeCodexRollout(
    home,
    checkout,
    codexTurn({ complete: false }),
  );
  assert.equal(getCodexSessions(worktrees)[0].active, true);
  appendFileSync(
    file,
    JSON.stringify(codexRow(8, "event_msg", { type: "turn_aborted" })) + "\n",
  );
  assert.equal(getCodexSessions(worktrees)[0].active, false);
  appendFileSync(
    file,
    JSON.stringify(codexRow(9, "event_msg", { type: "task_started" })) + "\n",
  );
  assert.equal(getCodexSessions(worktrees)[0].active, true);
  const later = Date.now() + 13 * 60 * 1000;
  t.mock.method(Date, "now", () => later);
  assert.equal(getCodexSessions(worktrees)[0].active, false);
  t.mock.restoreAll();
  const old = new Date(Date.now() - 13 * 60 * 1000);
  utimesSync(file, old, old);
  assert.equal(getCodexSessions(worktrees)[0].active, false);
  assert.equal(getCodexSessions(worktrees)[0].eventState, "stale");
});

test("absent, malformed and archived Codex data degrade without hiding other sessions", (t) => {
  const { home, checkout, worktrees } = fixture(t);
  assert.deepEqual(getCodexSessions(worktrees), []);
  const otherHome = home + "-populated";
  process.env.CODEX_HOME = otherHome;
  const file = writeCodexRollout(otherHome, checkout);
  mkdirSync(join(otherHome, "archived_sessions"));
  renameSync(
    file,
    join(otherHome, "archived_sessions", "rollout-archived.jsonl"),
  );
  writeFileSync(file, '{"type":"session_meta","payload":');
  assert.deepEqual(getCodexSessions(worktrees), []);
  assert.equal(resolveCodexTranscript("../../outside", checkout), null);
});

test("fresh Codex events keep an open Windows rollout live when its mtime is stale", (t) => {
  const { home, checkout, worktrees } = fixture(t);
  const file = writeCodexRollout(
    home,
    checkout,
    codexTurn({ complete: false }),
  );
  const now = Date.now();
  appendFileSync(
    file,
    JSON.stringify({
      ...codexRow(0, "event_msg", { type: "task_started" }),
      timestamp: new Date(now).toISOString(),
    }) + "\n",
  );
  const stale = new Date(now - 60 * 60 * 1000);
  utimesSync(file, stale, stale);
  const agent = getCodexSessions(worktrees)[0];
  assert.equal(agent.active, true);
  assert.equal(agent.lastActivity, new Date(now).toISOString());
});

test("feed pairs Codex calls and results without duplicate prompts or internal instructions", (t) => {
  const { home, checkout } = fixture(t);
  const file = writeCodexRollout(home, checkout, [
    codexRow(0, "response_item", {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "private system context" }],
    }),
    ...codexTurn(),
    codexRow(7, "response_item", {
      type: "custom_tool_call",
      call_id: "patch",
      name: "apply_patch",
      input: "*** Begin Patch",
    }),
    codexRow(8, "response_item", {
      type: "custom_tool_call_output",
      call_id: "patch",
      output: '{"output":"failed patch","metadata":{"exit_code":1}}',
    }),
  ]);
  const feed = getSessionFeed(file, { provider: "codex" });
  assert.equal(feed.events.filter((e) => e.kind === "user").length, 1);
  const tools = feed.events.filter((e) => e.kind === "tool");
  assert.equal(tools[0].summary, "node --test");
  assert.equal(tools[0].result.ok, true);
  assert.equal(tools[1].tool, "apply_patch");
  assert.equal(tools[1].result.ok, false);
  assert.equal(JSON.stringify(feed).includes("private system context"), false);
  appendFileSync(file, '\nnull\nfalse\n[]\n{"payload":');
  assert.deepEqual(getSessionFeed(file, { provider: "codex" }), feed);
});

test("Codex trace pairs spans, closes turns and counts request usage once", (t) => {
  const { home, checkout } = fixture(t);
  const rows = codexTurn();
  rows.splice(7, 0, rows[6]);
  const trace = getSessionTrace(writeCodexRollout(home, checkout, rows), {
    provider: "codex",
    sessionLive: false,
  });
  assert.equal(trace.turns.length, 1);
  const turn = trace.turns[0];
  assert.equal(turn.open, false);
  assert.equal(turn.durMs, 6000);
  assert.equal(turn.spans[0].durMs, 2000);
  assert.deepEqual(turn.usage, {
    input: 60,
    output: 15,
    cacheRead: 40,
    cacheCreate: 0,
    requests: 1,
  });
});

test("legacy token totals dedupe, and partial tails never claim historical tokens", (t) => {
  const { home, checkout } = fixture(t);
  const usage = codexRow(4, "event_msg", {
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: 10000, output_tokens: 900 },
      last_token_usage: { input_tokens: 100, output_tokens: 10 },
    },
  });
  const rows = [
    codexRow(0, "event_msg", { type: "task_started" }),
    usage,
    usage,
    codexRow(5, "event_msg", { type: "task_complete" }),
  ];
  const trace = getSessionTrace(writeCodexRollout(home, checkout, rows), {
    provider: "codex",
  });
  assert.equal(trace.turns[0].usage.input, 100);
  assert.equal(trace.turns[0].usage.requests, 1);
});

test("unfinished Codex tools are only running while live; bounded tails drop partial turns", (t) => {
  const { home, checkout } = fixture(t);
  const rows = codexTurn({ complete: false }).slice(0, 5);
  const file = writeCodexRollout(home, checkout, rows);
  const live = getSessionTrace(file, {
    provider: "codex",
    sessionLive: true,
    now: CODEX_T0 + 5000,
  });
  assert.equal(live.turns[0].spans[0].running, true);
  const dead = getSessionTrace(file, { provider: "codex", sessionLive: false });
  assert.equal(dead.turns[0].spans[0].incomplete, true);
  const tail = getSessionTrace(file, { provider: "codex", maxTailBytes: 150 });
  assert.equal(tail.truncated, true);
  assert.deepEqual(tail.turns, []);
});

test("Claude feeds keep their first record and selection distinguishes providers", (t) => {
  const { dir } = fixture(t);
  const file = join(dir, "claude.jsonl");
  writeFileSync(
    file,
    JSON.stringify({ type: "user", message: { content: "first prompt" } }) +
      "\n",
  );
  assert.equal(getSessionFeed(file).events[0].text, "first prompt");
  const agents = ["claude", "codex"].map((provider) => ({
    latestSessionId: CODEX_ID,
    provider,
    path: dir,
    branch: "main",
  }));
  assert.equal(
    pickSession(
      { store: { feedSession: { id: CODEX_ID, provider: "codex" } } },
      agents,
    ).provider,
    "codex",
  );
});
