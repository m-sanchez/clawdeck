import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import profilesModule from "../server/monitor/profiles.cjs";
import {
  SubscriptionMonitor,
  readSubscriptionSnapshot,
} from "../server/monitor/subscriptions.mjs";
import { SessionMonitor } from "../server/monitor/collector.mjs";
const { accountProfiles, profileSources, sessionProfiles } = profilesModule;
const now = Date.now();
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ocelin-accounts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const client = (email, used, calls = []) => ({
  async call(method) {
    calls.push(method);
    return method === "account/read"
      ? { account: { type: "chatgpt", email, planType: "pro" } }
      : {
          rateLimits: {
            primary: {
              usedPercent: used,
              windowDurationMins: 10080,
              resetsAt: now / 1000 + 3600,
            },
          },
        };
  },
  stop() {},
});
test("profile configuration excludes duplicate, remote and invalid homes", () => {
  const home = join(tmpdir(), "codex-work"),
    env = { CODEX_HOME: home };
  const profiles = accountProfiles(
    [
      { provider: "codex", home },
      { provider: "claude", home, label: "Work" },
      { provider: "claude", home, label: "Duplicate" },
      { provider: "claude", home: "relative" },
      { provider: "other", home },
      { provider: "codex", home: "\\\\server\\profile" },
    ],
    env,
  );
  assert.equal(profiles.length, 3);
  assert.equal(profiles[2].label, "Work");
  assert.equal(
    accountProfiles([{ ...profiles[2], label: "Renamed" }], env)[2].id,
    profiles[2].id,
  );
});
test("additional profiles extend configured sources without changing default homes", () => {
  const home = join(tmpdir(), "codex-work"),
    original = [
      { provider: "claude", root: join(tmpdir(), "custom-transcripts") },
    ];
  const sources = profileSources(original, [{ provider: "codex", home }]);
  assert.equal(original.length, 1);
  assert.deepEqual(sources, [
    ...original,
    { provider: "codex", root: join(home, "sessions") },
  ]);
  assert.deepEqual(
    sessionProfiles(
      { provider: "codex", sourceRoots: [join(home, "sessions")] },
      accountProfiles([{ provider: "codex", home, label: "Work" }]),
    ).map((p) => p.label),
    ["Work"],
  );
  assert.deepEqual(
    sessionProfiles(
      { provider: "codex", cwd: home },
      accountProfiles([{ provider: "codex", home }]),
    ),
    [],
  );
});
test("Codex profiles have isolated clients, identities and quotas without inherited token overrides", async (t) => {
  const dir = await fixture(t),
    work = join(dir, "work"),
    broken = join(dir, "broken");
  const envs = [];
  const monitor = new SubscriptionMonitor({
    dataDir: dir,
    env: {
      CODEX_ACCESS_TOKEN: "must-not-inherit",
      OPENAI_API_KEY: "must-not-inherit",
    },
    client: client("personal@example.test", 10),
    profiles: [
      { provider: "codex", home: work, label: "Work" },
      { provider: "codex", home: broken, label: "Expired" },
    ],
    clientFactory: (env) => {
      envs.push(env);
      return env.CODEX_HOME === work
        ? client("work@example.test", 70)
        : {
            async call() {
              throw new Error("failed secret");
            },
            stop() {},
          };
    },
    fetcher: async () => new Response("", { status: 401 }),
  });
  await monitor.refresh();
  monitor.stop();
  assert.equal(monitor.value.codex.windows[0].remainingPercent, 90);
  assert.equal(monitor.value.profiles[0].windows[0].remainingPercent, 30);
  assert.equal(monitor.value.profiles[0].accountLabel, "work@example.test");
  assert.equal(monitor.value.profiles[1].status, "unavailable");
  assert.deepEqual(
    envs.map((e) => e.CODEX_HOME),
    [work, broken],
  );
  assert.ok(envs.every((e) => !e.CODEX_ACCESS_TOKEN && !e.OPENAI_API_KEY));
  const cached = await readSubscriptionSnapshot(dir);
  assert.equal(cached.profiles.length, 2);
  assert.equal(cached.profiles[0].profileLabel, "Work");
  assert.ok(
    !(await readFile(join(dir, "subscriptions.json"), "utf8")).includes(
      "secret",
    ),
  );
});
test("Claude profiles use their own tokens for both allowance and account identity", async (t) => {
  const dir = await fixture(t),
    first = join(dir, "first"),
    second = join(dir, "second");
  for (const [home, token] of [
    [first, "personal-token"],
    [second, "work-token"],
  ]) {
    await mkdir(home);
    await writeFile(
      join(home, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: token,
          scopes: ["user:profile"],
          expiresAt: now + 60000,
        },
      }),
    );
  }
  const requests = [];
  const monitor = new SubscriptionMonitor({
    dataDir: dir,
    env: { CLAUDE_CONFIG_DIR: first },
    client: client("codex@example.test", 0),
    profiles: [{ provider: "claude", home: second, label: "Work" }],
    fetcher: async (url, options) => {
      const work = options.headers.Authorization === "Bearer work-token";
      requests.push([url, work]);
      return new Response(
        JSON.stringify(
          url.endsWith("/profile")
            ? {
                account: {
                  email: work ? "work@example.test" : "personal@example.test",
                },
              }
            : { seven_day: { utilization: work ? 66 : 11 } },
        ),
      );
    },
  });
  await monitor.refresh();
  monitor.stop();
  assert.equal(monitor.value.claude.windows[0].remainingPercent, 89);
  assert.equal(monitor.value.profiles[0].windows[0].remainingPercent, 34);
  assert.equal(monitor.value.profiles[0].accountLabel, "work@example.test");
  assert.equal(requests.filter((r) => r[1]).length, 2);
  const raw = await readFile(join(dir, "subscriptions.json"), "utf8");
  assert.ok(!raw.includes("personal-token") && !raw.includes("work-token"));
});
test("removing a profile while a request is running discards the late result", async (t) => {
  const dir = await fixture(t),
    home = join(dir, "work");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const active = new Promise((resolve) => {
    started = resolve;
  });
  const updates = [];
  const workClient = client("work@example.test", 80);
  const original = workClient.call;
  workClient.call = async (method) => {
    started();
    await gate;
    return original(method);
  };
  const monitor = new SubscriptionMonitor({
    dataDir: dir,
    client: client("personal@example.test", 10),
    profiles: [{ provider: "codex", home }],
    clientFactory: () => workClient,
    fetcher: async () => new Response("", { status: 401 }),
    onUpdate: (value) => updates.push(JSON.stringify(value)),
  });
  const pending = monitor.refresh();
  await active;
  monitor.setProfiles([]);
  const afterRemoval = updates.length;
  release();
  await pending;
  await monitor.refresh();
  monitor.stop();
  assert.equal(monitor.value.profiles.length, 0);
  assert.ok(
    updates
      .slice(afterRemoval)
      .every((value) => !value.includes("work@example.test")),
  );
});
test("session provenance follows source folders and retains shared session identity", async (t) => {
  const dir = await fixture(t),
    a = join(dir, "a"),
    b = join(dir, "b");
  for (const home of [a, b]) {
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(
      join(home, "sessions", "session.jsonl"),
      JSON.stringify({
        type: "session_meta",
        timestamp: new Date(now).toISOString(),
        payload: { id: "same-session", cwd: dir },
      }) + "\n",
    );
  }
  const configs = [
    { provider: "codex", home: a, label: "Personal" },
    { provider: "codex", home: b, label: "Work" },
  ];
  const monitor = new SessionMonitor({
    dataDir: join(dir, "data"),
    sources: profileSources([], configs),
    desktopRoot: null,
  });
  const snapshot = await monitor.tick({ force: true });
  assert.equal(snapshot.sessions.length, 1);
  assert.deepEqual(
    sessionProfiles(snapshot.sessions[0], accountProfiles(configs)).map(
      (p) => p.label,
    ),
    ["Personal", "Work"],
  );
  monitor.setSources([]);
  assert.equal(monitor.snapshot().sessions.length, 0);
  assert.ok(
    (await readFile(join(a, "sessions", "session.jsonl"), "utf8")).includes(
      "same-session",
    ),
  );
});
