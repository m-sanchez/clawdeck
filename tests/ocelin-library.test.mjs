import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  utimes,
  rm,
  appendFile,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, relative } from "node:path";
import { createRequire } from "node:module";
import { SessionLibrary } from "../server/library/catalog.mjs";
import {
  writeCodexRollout,
  codexTurn,
  CODEX_ID,
  CODEX_OTHER_ID,
} from "./helpers/codex-fixture.mjs";
const require = createRequire(import.meta.url);
const {
  sessionLink,
  activation,
  activationUri,
} = require("../desktop/lib/session-links.cjs");
const {
  nativeSnapshot,
  NativeTasks,
} = require("../desktop/lib/native-tasks.cjs");
const now = Date.now();

async function fixture(t, rows = codexTurn()) {
  const dir = await mkdtemp(join(tmpdir(), "ocelin-library-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "codex"),
    claude = join(dir, "claude"),
    dataDir = join(dir, "data");
  await mkdir(claude);
  const path = writeCodexRollout(home, join(dir, "deleted-workspace"), rows);
  await utimes(
    path,
    new Date(now - 86400000 * 120),
    new Date(now - 86400000 * 120),
  );
  const calls = [],
    descendants = [];
  const paths = new Map([[CODEX_ID, path]]);
  const client = {
    executable: "fixture",
    stop() {},
    async call(method, args) {
      calls.push({ method, args });
      if (method === "thread/read")
        return {
          thread: {
            id: args.threadId,
            path: paths.get(args.threadId),
            status: { type: "idle" },
          },
        };
      if (method === "thread/list")
        return {
          data: descendants.filter((d) => d.parent === args.ancestorThreadId),
          nextCursor: null,
        };
      if (["thread/archive", "thread/unarchive"].includes(method)) {
        const file = paths.get(args.threadId);
        const root = join(
          home,
          method === "thread/archive" ? "archived_sessions" : "sessions",
        );
        await mkdir(root, { recursive: true });
        const target = join(root, basename(file));
        await rename(file, target);
        paths.set(args.threadId, target);
        return {};
      }
      throw new Error("Unexpected fixture call");
    },
  };
  const library = new SessionLibrary({
    dataDir,
    sources: [
      { provider: "codex", root: join(home, "sessions") },
      { provider: "claude", root: claude },
    ],
    desktopRoot: null,
    now: () => now,
    client,
  });
  await library.load();
  return {
    dir,
    home,
    claude,
    dataDir,
    path,
    library,
    calls,
    client,
    descendants,
    paths,
  };
}

test("history reads old conversations and previews without an existing workspace", async (t) => {
  const { library } = await fixture(t);
  const result = await library.query({ search: "check project" });
  assert.equal(result.total, 1);
  assert.equal(result.entries[0].workspaceExists, false);
  assert.equal(result.entries[0].file, undefined);
  const preview = await library.preview(`codex:${CODEX_ID}`);
  assert.equal(preview.request, "Check the project");
  assert.equal(preview.response, "Tests passed.");
  assert.ok(preview.activity.some((e) => e.tool === "exec_command"));
  assert.ok(!preview.events.some((e) => e.kind === "thinking"));
});

test("live previews skip the full index and reject mismatched or outside hints", async (t) => {
  const { library, path, dir } = await fixture(t);
  library.refresh = async () => {
    throw new Error("Unexpected history scan");
  };
  const key = `codex:${CODEX_ID}`;
  const hint = { key, provider: "codex", transcript: path };
  assert.equal((await library.preview(key, hint)).request, "Check the project");
  await assert.rejects(
    library.preview(`codex:${CODEX_OTHER_ID}`, {
      ...hint,
      key: `codex:${CODEX_OTHER_ID}`,
    }),
    /identity changed/,
  );
  const outside = join(dir, "outside.jsonl");
  await writeFile(outside, await readFile(path));
  await assert.rejects(
    library.preview(key, { ...hint, transcript: outside }),
    /outside/,
  );
});

test("paginated Codex previews use native history and explain unavailable history", async (t) => {
  const { library, path, client } = await fixture(t);
  const rows = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  rows[0].payload.history_mode = "paginated";
  await writeFile(path, JSON.stringify(rows[0]) + "\n");
  const original = client.call;
  client.call = async (method, args) =>
    method === "thread/turns/list"
      ? {
          data: [
            {
              items: [
                {
                  type: "userMessage",
                  content: [{ type: "text", text: "Native request" }],
                },
                { type: "agentMessage", text: "Native answer" },
              ],
            },
          ],
        }
      : original(method, args);
  let preview = await library.preview(`codex:${CODEX_ID}`);
  assert.equal(preview.request, "Native request");
  assert.equal(preview.response, "Native answer");
  assert.equal(preview.previewSource, "Codex native history");
  client.call = original;
  preview = await library.preview(`codex:${CODEX_ID}`);
  assert.match(preview.previewWarning, /unavailable/);
});

test("equivalent local path aliases preserve provider identity and preview containment", async (t) => {
  const { library, dir, home, path, client, calls } = await fixture(t);
  const alias = join(dir, "home-alias");
  await symlink(home, alias, process.platform === "win32" ? "junction" : "dir");
  const aliasedFile = join(alias, relative(home, path));
  const original = client.call;
  client.call = async (method, args) =>
    method === "thread/read"
      ? { thread: { path: aliasedFile } }
      : original(method, args);
  const key = `codex:${CODEX_ID}`;
  const preview = await library.preview(key, {
    key,
    provider: "codex",
    transcript: aliasedFile,
  });
  assert.equal(preview.response, "Tests passed.");
  assert.ok(calls.some((c) => c.method === "thread/turns/list"));
  assert.equal(
    (await library.plan({ operation: "archive", keys: [key] })).scope,
    "Codex native history",
  );
});

test("Claude text-block requests preview and reversible local hide retain originals", async (t) => {
  const { library, claude } = await fixture(t);
  const file = join(claude, "cccc.jsonl");
  await writeFile(
    file,
    JSON.stringify({
      sessionId: "cccc",
      cwd: claude,
      type: "user",
      message: { content: [{ type: "text", text: "Find my saved report" }] },
    }) + "\n",
  );
  await library.refresh(true);
  assert.equal(
    (await library.preview("claude:cccc")).request,
    "Find my saved report",
  );
  const before = await readFile(file, "utf8");
  const plan = await library.plan({ operation: "hide", keys: ["claude:cccc"] });
  assert.equal(plan.diskBytesFreed, 0);
  assert.equal(plan.scope, "Ocelin only");
  await library.apply(plan.id);
  assert.equal((await library.query()).total, 1);
  assert.equal(
    (await library.query({ view: "archived" })).entries[0].archiveScope,
    "Hidden in Ocelin",
  );
  await library.apply(
    (await library.plan({ operation: "unhide", keys: ["claude:cccc"] })).id,
  );
  assert.equal((await library.query()).total, 2);
  assert.equal(await readFile(file, "utf8"), before);
  library.entries.get("claude:cccc").nativeArchived = true;
  assert.equal(
    (
      await library.preview("claude:cccc", {
        key: "claude:cccc",
        provider: "claude",
        transcript: file,
      })
    ).nativeArchived,
    true,
  );
});

test("native index dates drive age filters and mismatched homes never overlay previews", async (t) => {
  const { library, home, path, client, calls } = await fixture(t);
  client.env = { CODEX_HOME: home };
  const original = client.call;
  const providerFile = process.platform === "win32" ? "\\\\?\\" + path : path;
  client.call = async (method, args) => {
    if (method === "thread/list" && !args.ancestorThreadId)
      return {
        data: args.archived
          ? []
          : [
              {
                id: CODEX_ID,
                path: providerFile,
                cwd: home,
                name: "Current native task",
                updatedAt: Math.floor(now / 1000),
                historyMode: "paginated",
              },
            ],
        nextCursor: null,
      };
    return original(method, args);
  };
  const page = await library.query();
  assert.equal(page.entries[0].displayTitle, "Current native task");
  assert.ok(now - page.entries[0].lastTs < 1000);
  assert.equal((await library.query({ olderDays: 30 })).total, 0);
  client.call = async (method, args) =>
    method === "thread/read"
      ? { thread: { path: providerFile } }
      : original(method, args);
  calls.length = 0;
  await library.preview(`codex:${CODEX_ID}`);
  assert.ok(calls.some((c) => c.method === "thread/turns/list"));
  client.call = async (method, args) =>
    method === "thread/read"
      ? { thread: { path: join(home, "different.jsonl") } }
      : original(method, args);
  calls.length = 0;
  const preview = await library.preview(`codex:${CODEX_ID}`);
  assert.equal(preview.response, "Tests passed.");
  assert.match(preview.previewWarning, /unavailable/);
  assert.ok(!calls.some((c) => c.method === "thread/turns/list"));
});

test("cleanup rejects stale plans and refuses unknown or active native sessions", async (t) => {
  const { library, path } = await fixture(t);
  const plan = await library.plan({
    operation: "hide",
    keys: [`codex:${CODEX_ID}`],
  });
  await appendFile(path, "\n");
  await assert.rejects(library.apply(plan.id), /changed/);
  await library.refresh(true);
  await assert.rejects(
    library.plan({ operation: "archive", keys: [`codex:${CODEX_ID}`] }),
    /active|recently/,
  );
  await assert.rejects(library.preview("codex:../../secret"), /Invalid/);
  await assert.rejects(
    library.plan({ operation: "delete", keys: [`codex:${CODEX_ID}`] }),
    /supported action/,
  );
});

test("old quiet running tasks are never treated as safely completed", async (t) => {
  const { library, calls } = await fixture(t, codexTurn({ complete: false }));
  await assert.rejects(
    library.plan({ operation: "archive", keys: [`codex:${CODEX_ID}`] }),
    /no confirmed completion/,
  );
  assert.ok(!calls.some((c) => c.method === "thread/archive"));
});

test("native Codex archive and restore use its API and move the library entry", async (t) => {
  const { library, calls } = await fixture(t);
  const key = `codex:${CODEX_ID}`;
  const plan = await library.plan({ operation: "archive", keys: [key] });
  assert.equal(plan.scope, "Codex native history");
  assert.deepEqual((await library.apply(plan.id)).results, [{ key, ok: true }]);
  assert.equal((await library.query()).total, 0);
  assert.equal(
    (await library.query({ view: "archived" })).entries[0].nativeArchived,
    true,
  );
  const restore = await library.plan({ operation: "unarchive", keys: [key] });
  await library.apply(restore.id);
  assert.equal((await library.query()).total, 1);
  assert.equal(calls.filter((c) => c.method === "thread/archive").length, 1);
  assert.equal(calls.filter((c) => c.method === "thread/unarchive").length, 1);
});

test("native descendants appearing after preview block cascading archival", async (t) => {
  const { library, descendants, calls } = await fixture(t);
  const plan = await library.plan({
    operation: "archive",
    keys: [`codex:${CODEX_ID}`],
  });
  descendants.push({ id: CODEX_OTHER_ID, parent: CODEX_ID });
  await assert.rejects(library.apply(plan.id), /every child/);
  assert.ok(!calls.some((c) => c.method === "thread/archive"));
});

test("native archive checks every child and archives children before parents", async (t) => {
  const { library, home, paths, descendants, calls } = await fixture(t);
  const child = writeCodexRollout(home, home, codexTurn(), CODEX_OTHER_ID);
  const content = await readFile(child, "utf8");
  const rows = content.trim().split("\n").map(JSON.parse);
  rows[0].payload.source = {
    subagent: { thread_spawn: { parent_thread_id: CODEX_ID } },
  };
  await writeFile(child, rows.map(JSON.stringify).join("\n") + "\n");
  await utimes(child, new Date(now - 86400000), new Date(now - 86400000));
  paths.set(CODEX_OTHER_ID, child);
  descendants.push({ id: CODEX_OTHER_ID, parent: CODEX_ID });
  const unrelatedId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const unrelated = writeCodexRollout(home, home, codexTurn(), unrelatedId);
  await utimes(unrelated, new Date(now - 86400000), new Date(now - 86400000));
  paths.set(unrelatedId, unrelated);
  const plan = await library.plan({
    operation: "archive",
    keys: [
      `codex:${CODEX_ID}`,
      `codex:${unrelatedId}`,
      `codex:${CODEX_OTHER_ID}`,
    ],
  });
  assert.equal(
    (await library.apply(plan.id)).results.every((r) => r.ok),
    true,
  );
  assert.deepEqual(
    calls
      .filter((c) => c.method === "thread/archive")
      .map((c) => c.args.threadId),
    [CODEX_OTHER_ID, CODEX_ID, unrelatedId],
  );
});

test("search and pagination keep a 10000-session library bounded", async (t) => {
  const { library } = await fixture(t);
  library.scannedAt = now;
  for (let n = 0; n < 10000; n++)
    library.entries.set(`codex:item-${n}`, {
      key: `codex:item-${n}`,
      provider: "codex",
      sessionId: `item-${n}`,
      displayTitle: `Work ${n}`,
      cwd: "",
      lastTs: now - n,
      bytes: 10,
      request: n === 9999 ? "needle" : "",
    });
  const page = await library.query({ limit: 100000 });
  assert.equal(page.entries.length, 100);
  assert.equal(page.total, 10000);
  assert.equal(page.next, 100);
  assert.equal(
    (await library.query({ search: "needle" })).entries[0].sessionId,
    "item-9999",
  );
});

test("session links reject arbitrary routes and retain exact provider identities", () => {
  assert.equal(
    sessionLink({ provider: "codex", sessionId: CODEX_ID }),
    `codex://threads/${CODEX_ID}`,
  );
  assert.equal(
    sessionLink({ provider: "claude", sessionId: CODEX_ID }),
    `claude://resume?session=${CODEX_ID}`,
  );
  assert.deepEqual(
    activation(activationUri({ provider: "claude", sessionId: CODEX_ID })),
    { type: "session", key: `claude:${CODEX_ID}` },
  );
  for (const uri of [
    "ocelin://app/../../file",
    "ocelin://session/claude/../evil",
    "ocelin://session/codex/a?cmd=run",
    "ocelin://user@dashboard",
    "https://dashboard",
  ])
    assert.equal(activation(uri), null);
  assert.throws(() =>
    sessionLink({ provider: "claude", sessionId: "x&cmd=run" }),
  );
});

test("native tasks publish fresh status only and isolated profiles cannot activate the user bridge", () => {
  const state = {
    sampledAt: now,
    counts: { running: 1, attention: 0 },
    sessions: [
      {
        key: `codex:${CODEX_ID}`,
        provider: "codex",
        sessionId: CODEX_ID,
        title: "Demo",
        execution: "running",
        label: "Running",
        stale: false,
      },
    ],
  };
  const fresh = nativeSnapshot(state, true, now);
  assert.equal(fresh.tasks.length, 2);
  assert.equal(fresh.tasks[1].uri, `ocelin://session/codex/${CODEX_ID}`);
  assert.equal(nativeSnapshot(state, true, now + 60000).tasks.length, 1);
  assert.deepEqual(nativeSnapshot(state, false, now).tasks, []);
  const bridge = new NativeTasks(
    join(tmpdir(), "isolated-ocelin"),
    "missing.ps1",
  );
  bridge.publish(state, true);
  assert.equal(bridge.value.status, "unavailable");
  assert.equal(bridge.lastLaunch, 0);
});

test("re-enabling native tasks reconnects instead of trusting a stopped helper heartbeat", async (t) => {
  const { dir } = await fixture(t);
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  });
  const dataDir = join(dir, "Ocelin");
  const bridge = new NativeTasks(dataDir, "unused.ps1");
  let launches = 0;
  bridge.start = () => {
    launches++;
    bridge.lastLaunch = Date.now();
    bridge.bridgeDir = dataDir;
  };
  const state = {
    sampledAt: Date.now(),
    counts: { running: 0, attention: 0 },
    sessions: [],
  };
  bridge.publish(state, true);
  await writeFile(
    join(dataDir, "native-status.json"),
    JSON.stringify({ sampledAt: Date.now(), supported: true, tasks: 1 }),
  );
  bridge.publish(state, false);
  bridge.publish(state, true);
  assert.equal(launches, 2);
});
