import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  groupSessions,
  statusLabel,
} from "../desktop/renderer/session-model.mjs";
const require = createRequire(import.meta.url);
const { summarize } = require("../desktop/lib/resource-model.cjs");
const { taskbarSummary } = require("../desktop/lib/taskbar-bridge.cjs");
const now = Date.now();
const session = (id, patch = {}) => ({
  key: `codex:${id}`,
  sessionId: id,
  provider: "codex",
  cwd: "C:\\work\\Project",
  title: "Project",
  lastTs: now,
  execution: "running",
  stale: false,
  ...patch,
});

test("default view groups concurrent providers by project and excludes historical sessions", () => {
  const groups = groupSessions([
    session("a"),
    session("b", {
      provider: "claude",
      key: "claude:b",
      cwd: "c:/work/project/",
      attention: "permission",
      execution: "waiting",
    }),
    session("old", { stale: true }),
    session("done", { execution: "idle" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessions.length, 2);
  assert.equal(groups[0].running, 1);
  assert.equal(groups[0].attention, 1);
  assert.equal(groups[0].sessions[0].sessionId, "b");
});
test("clearing history keeps active work and allows a session back after new activity", () => {
  const old = session("old", { lastTs: now - 1000, execution: "idle" });
  const active = session("active", { lastTs: now - 2000 });
  assert.equal(
    groupSessions([old, active], { filter: "all", historySince: now }).flatMap(
      (g) => g.sessions,
    ).length,
    1,
  );
  assert.equal(
    groupSessions([old, active], { filter: "all", historySince: 0 }).flatMap(
      (g) => g.sessions,
    ).length,
    2,
  );
  assert.equal(
    groupSessions([{ ...old, lastTs: now + 1 }], {
      filter: "all",
      historySince: now,
    }).length,
    1,
  );
});
test("stale permission and running signals are labelled unknown and excluded from attention", () => {
  const s = session("stale", {
    stale: true,
    attention: "permission",
    label: "Needs permission",
  });
  assert.equal(statusLabel(s), "Status unknown");
  assert.equal(groupSessions([s], { filter: "attention" }).length, 0);
});
test("resource totals distinguish inaccessible memory and normalize CPU without PID reuse spikes", () => {
  const old = {
    sampledAt: 1000,
    processes: [{ pid: 1, started: 4, cpuSeconds: 10 }],
  };
  const current = {
    sampledAt: 3000,
    processes: [
      {
        pid: 1,
        started: 4,
        provider: "codex",
        name: "codex.exe",
        memoryBytes: 1024,
        cpuSeconds: 14,
      },
      {
        pid: 2,
        started: 8,
        provider: "codex",
        name: "node.exe",
        memoryBytes: null,
        cpuSeconds: null,
      },
    ],
  };
  let group = summarize(current, old, 4).groups[0];
  assert.equal(group.memoryBytes, 1024);
  assert.equal(group.cpuPercent, 50);
  assert.equal(group.unavailable, 1);
  assert.equal(summarize(current, old, 4).memoryBytes, null);
  current.processes[0].started = 9;
  group = summarize(current, old, 4).groups[0];
  assert.equal(group.cpuPercent, null);
});
test("taskbar export is opt-in, aggregate-only and rejects stale memory", () => {
  const state = {
    counts: { running: 2, attention: 1 },
    sessions: [{ title: "PRIVATE" }],
    resources: {
      status: "ready",
      sampledAt: now,
      groups: [
        { provider: "claude", memoryBytes: 100 },
        { provider: "ocelin", memoryBytes: 200 },
      ],
    },
  };
  const data = taskbarSummary(state, true, now);
  assert.equal(data.memoryBytes, 100);
  assert.equal(data.running, 2);
  assert.ok(!JSON.stringify(data).includes("PRIVATE"));
  assert.equal(taskbarSummary(state, false, now).running, null);
  assert.equal(taskbarSummary(state, true, now + 40000).memoryBytes, null);
  state.resources.groups[0].unavailable = 1;
  assert.equal(taskbarSummary(state, true, now).memoryBytes, null);
});
test(
  "native taskbar provider refreshes without more stdin and exits on shutdown",
  { skip: process.platform !== "win32", timeout: 20000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "ocelin-widget-test-"));
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + "\\"));
    await mkdir(join(dir, "Ocelin"));
    const file = join(dir, "Ocelin", "taskbar-summary.json");
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        status: "ready",
        sampledAt: Date.now(),
        running: 2,
        attention: 1,
        memoryBytes: 1024 ** 3,
      }),
    );
    const child = spawn(
      join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve("desktop/integrations/taskbar-widgets/provider.ps1"),
      ],
      {
        windowsHide: true,
        env: { ...process.env, LOCALAPPDATA: dir },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const finished = new Promise((resolveExit) =>
      child.once("exit", resolveExit),
    );
    t.after(async () => {
      child.kill();
      await finished;
      await rm(dir, { recursive: true, force: true });
    });
    const rows = [];
    let buffer = "",
      stderr = "";
    child.stderr.on("data", (b) => (stderr += b));
    child.stdout.on("data", (b) => {
      buffer += b;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        rows.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
    child.stdin.write(
      JSON.stringify({
        type: "initialize",
        instances: [{ instanceId: "fixture" }],
      }) + "\n",
    );
    const wait = async (predicate) => {
      for (let i = 0; i < 60; i++) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(`Widget did not respond: ${stderr}`);
    };
    await wait(() =>
      rows.some((r) => r.data?.headline === "2 running | 1 need you"),
    );
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        status: "ready",
        sampledAt: Date.now() - 40000,
        running: 9,
      }),
    );
    await wait(() => rows.some((r) => r.data?.headline === "Ocelin offline"));
    child.stdin.write('{"type":"shutdown"}\n');
    assert.equal(await finished, 0);
  },
);
