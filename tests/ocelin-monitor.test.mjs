import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  appendFile,
  utimes,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reduceSession, presentSession } from "../server/monitor/model.mjs";
import { IncrementalReader } from "../server/monitor/reader.mjs";
import { SessionMonitor } from "../server/monitor/collector.mjs";
import { Integrations } from "../server/monitor/integrations.mjs";
import preferences from "../desktop/lib/preferences.cjs";

const epoch = Date.now() - 10000;
const event = (kind, n = 0, extra = {}) => ({
  provider: "codex",
  sessionId: "same-id",
  id: `event-${n}`,
  ts: epoch + n,
  kind,
  cwd: tmpdir(),
  ...extra,
});
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "ocelin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("newer turns reject delayed old-turn completion and permission events", () => {
  let s = reduceSession(null, event("start", 1, { turnId: "one" }));
  s = reduceSession(s, event("start", 4, { turnId: "two" }));
  s = reduceSession(s, event("complete", 5, { turnId: "one" }));
  s = reduceSession(s, event("attention", 6, { turnId: "one" }));
  assert.equal(s.turnId, "two");
  assert.equal(s.execution, "running");
  assert.equal(s.attention, null);
  assert.equal(reduceSession(s, event("complete", 3, { turnId: "two" })), s);
});
test("silence never fabricates success or disconnects a long tool", () => {
  const s = presentSession(
    reduceSession(null, event("tool")),
    {},
    epoch + 3600000,
  );
  assert.equal(s.execution, "running");
  assert.equal(s.result, null);
  assert.equal(s.quality, "stale");
});
test("acknowledgement is separate from execution and clears only the observed signal", () => {
  const s = reduceSession(null, event("attention", 1));
  const first = presentSession(s, {});
  const seen = presentSession(s, { [s.key]: first.signal });
  assert.equal(seen.unseen, false);
  assert.equal(seen.attention, "permission");
  const next = presentSession(reduceSession(s, event("attention", 2)), {
    [s.key]: first.signal,
  });
  assert.equal(next.unseen, true);
});
test("interrupt and error never become successful turns", () => {
  for (const kind of ["interrupt", "error"]) {
    const s = presentSession(reduceSession(null, event(kind)), {});
    assert.notEqual(s.state, "success");
    assert.equal(s.result.kind, kind);
  }
});
test("incremental reader retains partial UTF-8 and detects growth with unchanged mtime", async (t) => {
  const dir = await temp(t),
    file = join(dir, "s.jsonl"),
    reader = new IncrementalReader(),
    records = [];
  const bytes = Buffer.from(JSON.stringify({ title: "Español 🐆" }) + "\n");
  await writeFile(file, bytes.subarray(0, bytes.length - 4));
  await reader.read(file, (r) => records.push(r));
  assert.equal(records.length, 0);
  await appendFile(file, bytes.subarray(bytes.length - 4));
  await utimes(file, new Date(epoch), new Date(epoch));
  await reader.read(file, (r) => records.push(r));
  assert.equal(records[0].title, "Español 🐆");
  await appendFile(file, '{"next":true}\n');
  await utimes(file, new Date(epoch), new Date(epoch));
  await reader.read(file, (r) => records.push(r));
  assert.equal(records.length, 2);
  const restored = new IncrementalReader(reader.checkpoint());
  await restored.read(file, (r) => records.push(r));
  assert.equal(records.length, 2);
});
test("rotation, truncation and malformed lines do not poison the next record", async (t) => {
  const dir = await temp(t),
    file = join(dir, "s.jsonl"),
    reader = new IncrementalReader(),
    seen = [];
  await writeFile(file, '{"a":1}\nbroken\n');
  await reader.read(file, (r) => seen.push(r));
  await rename(file, join(dir, "old.jsonl"));
  await writeFile(file, '{"b":2}\n');
  await reader.read(file, (r) => seen.push(r));
  await writeFile(file, "{}\n");
  await reader.read(file, (r) => seen.push(r));
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }, {}]);
});
test("monitor separates providers and concurrent sessions, recovers state and reads no unchanged transcript bytes", async (t) => {
  const dir = await temp(t),
    codex = join(dir, "codex"),
    claude = join(dir, "claude"),
    dataDir = join(dir, "data");
  await mkdir(codex);
  await mkdir(claude);
  const stamp = (n) => new Date(epoch + n).toISOString();
  await writeFile(
    join(codex, "rollout.jsonl"),
    [
      {
        type: "session_meta",
        timestamp: stamp(0),
        payload: { id: "same-id", cwd: dir },
      },
      {
        type: "event_msg",
        timestamp: stamp(1),
        payload: { type: "task_started", turn_id: "turn-1" },
      },
      {
        type: "event_msg",
        timestamp: stamp(2),
        payload: { type: "user_message", message: "PRIVATE PROMPT" },
      },
      {
        type: "event_msg",
        timestamp: stamp(3),
        payload: { type: "task_complete", turn_id: "turn-1" },
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  for (const id of ["same-id", "other-id"])
    await writeFile(
      join(claude, `${id}.jsonl`),
      JSON.stringify({
        type: "user",
        sessionId: id,
        cwd: id === "other-id" ? tmpdir() : dir,
        timestamp: stamp(1),
        message: { content: "PRIVATE PROMPT" },
      }) + "\n",
    );
  const options = {
    dataDir,
    sources: [
      { provider: "codex", root: codex },
      { provider: "claude", root: claude },
    ],
    desktopRoot: null,
  };
  const monitor = new SessionMonitor(options);
  const first = await monitor.tick();
  assert.equal(first.sessions.length, 3);
  assert.equal(
    first.sessions.find((s) => s.key === "codex:same-id").result.kind,
    "complete",
  );
  await monitor.acknowledge("codex:same-id");
  const bytes = monitor.bytesRead;
  await monitor.tick();
  assert.equal(monitor.bytesRead, bytes);
  const saved = await readFile(join(dataDir, "monitor.json"), "utf8");
  assert.equal(saved.includes("PRIVATE PROMPT"), false);
  const restored = new SessionMonitor(options);
  await restored.load();
  const next = await restored.tick();
  assert.equal(next.sessions.length, 3);
  assert.equal(restored.bytesRead, 0);
  assert.equal(
    next.sessions.find((s) => s.key === "codex:same-id").unseen,
    false,
  );
});
test("notification deduplication and acknowledgement survive a restart", async (t) => {
  const dataDir = await temp(t),
    monitor = new SessionMonitor({ dataDir, sources: [], now: () => epoch });
  monitor.apply(event("attention", 2));
  assert.equal((await monitor.notifications()).length, 1);
  assert.equal((await monitor.notifications()).length, 0);
  const next = new SessionMonitor({ dataDir, sources: [], now: () => epoch });
  await next.load();
  assert.equal((await next.notifications()).length, 0);
  next.apply(event("attention", 3));
  assert.equal((await next.notifications({ quiet: true })).length, 0);
  assert.equal((await next.notifications()).length, 0);
});
test("integration apply preserves foreign hooks; uninstall removes only owned entries", async (t) => {
  const dir = await temp(t),
    home = join(dir, "claude");
  await mkdir(home);
  const original = {
    model: "keep",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "keep-existing" }] }],
    },
  };
  await writeFile(join(home, "settings.json"), JSON.stringify(original));
  const i = new Integrations({
    dataDir: join(dir, "data"),
    runtime: process.execPath,
    captureFile: fileURLToPath(
      new URL("../hooks/ocelin-capture.cjs", import.meta.url),
    ),
    homes: { claude: home },
  });
  const preview = await i.preview("claude");
  assert.equal(
    JSON.parse(await readFile(join(home, "settings.json"))).model,
    "keep",
  );
  await i.apply(preview.id);
  let saved = JSON.parse(await readFile(join(home, "settings.json")));
  assert.equal(saved.hooks.Stop.length, 2);
  const second = await i.preview("claude");
  await i.apply(second.id);
  saved = JSON.parse(await readFile(join(home, "settings.json")));
  assert.equal(saved.hooks.Stop.length, 2);
  const remove = await i.preview("claude", true);
  await i.apply(remove.id);
  assert.deepEqual(
    JSON.parse(await readFile(join(home, "settings.json"))),
    original,
  );
});
test("integration refuses a stale preview after user edits", async (t) => {
  const dir = await temp(t),
    i = new Integrations({
      dataDir: join(dir, "data"),
      runtime: process.execPath,
      captureFile: "unused",
      homes: { codex: dir },
    });
  const p = await i.preview("codex");
  await writeFile(join(dir, "hooks.json"), '{"userChange":true}');
  await assert.rejects(i.apply(p.id), /Settings changed/);
});
test("capture hook persists only allowed metadata and does not block on malformed input", async (t) => {
  const dir = await temp(t),
    hook = fileURLToPath(
      new URL("../hooks/ocelin-capture.cjs", import.meta.url),
    );
  const r = spawnSync(process.execPath, [hook, "claude", dir], {
    windowsHide: true,
    input: JSON.stringify({
      session_id: "test-id",
      cwd: dir,
      hook_event_name: "PermissionRequest",
      tool_input: { command: "PRIVATE COMMAND" },
      prompt: "PRIVATE PROMPT",
    }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const monitor = new SessionMonitor({
    dataDir: dir,
    sources: [],
    desktopRoot: null,
  });
  const snapshot = await monitor.tick();
  assert.equal(snapshot.sessions[0].attention, "permission");
  assert.equal(
    (await readFile(join(dir, "monitor.json"), "utf8")).includes("PRIVATE"),
    false,
  );
  assert.equal(
    spawnSync(process.execPath, [hook, "claude", dir], {
      windowsHide: true,
      input: "broken",
    }).status,
    0,
  );
});
test("all surface combinations remain recoverable and offscreen windows recover", () => {
  for (const tray of [false, true])
    for (const bar of [false, true])
      for (const dashboard of [false, true]) {
        const p = preferences.validate({ tray, bar, dashboard });
        assert.ok(p.tray || p.bar || p.dashboard);
      }
  const bounds = preferences.recoverBounds(
    { x: 5000, y: -2000, width: 900, height: 100 },
    [{ workArea: { x: 0, y: 0, width: 800, height: 600 } }],
    {},
  );
  assert.deepEqual(bounds, { x: 0, y: 0, width: 800, height: 100 });
});
