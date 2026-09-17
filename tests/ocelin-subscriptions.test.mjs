import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  codexSubscription,
  claudeSubscription,
  SubscriptionMonitor,
  readSubscriptionSnapshot,
} from "../server/monitor/subscriptions.mjs";
import { allowanceDisplay } from "../ui/shared/subscriptions.mjs";
const now = 1800000000000;
const future = now / 1000 + 3600;
const bucket = (used, minutes = 10080) => ({
  primary: { usedPercent: used, windowDurationMins: minutes, resetsAt: future },
});
test("subscription percent is remaining and window duration determines its label", () => {
  const value = codexSubscription(
    {
      rateLimits: bucket(99),
      rateLimitsByLimitId: {
        codex: bucket(92),
        spark: { ...bucket(12, 300), limitName: "Spark" },
      },
    },
    { planType: "pro" },
    now,
  );
  assert.equal(value.windows[0].remainingPercent, 8);
  assert.equal(value.windows[0].label, "Weekly");
  assert.equal(value.windows[1].remainingPercent, 88);
  assert.equal(value.windows[1].extra, true);
  assert.equal(value.windows[0].resetsAt, future * 1000);
});
test("missing or malformed quota is unavailable, real zero used is 100 left", () => {
  for (const bad of [null, undefined, "0", NaN, -1, 101])
    assert.equal(
      codexSubscription({ rateLimits: bucket(bad) }, {}, now).windows[0]
        .remainingPercent,
      null,
    );
  assert.equal(
    codexSubscription({ rateLimits: bucket(0) }, {}, now).windows[0]
      .remainingPercent,
    100,
  );
  assert.equal(
    codexSubscription({ rateLimits: bucket(100) }, {}, now).windows[0]
      .remainingPercent,
    0,
  );
  assert.equal(codexSubscription({}, {}, now).status, "unavailable");
});
test("Claude percentage is not a fraction and absent windows and breakdowns stay absent", () => {
  const value = claudeSubscription(
    {
      five_hour: { utilization: 0, resets_at: null },
      seven_day: {
        utilization: 3,
        resets_at: new Date(future * 1000).toISOString(),
      },
      seven_day_opus: { utilization: 21, resets_at: null },
      seven_day_sonnet: null,
      seven_day_breakdown: { rows: [] },
      extra_usage: { utilization: 25 },
    },
    "max",
    now,
  );
  assert.deepEqual(
    value.windows.map((w) => w.remainingPercent),
    [100, 97, 79],
  );
  assert.equal(value.windows[0].resetsAt, null);
  assert.equal(value.windows[2].extra, true);
});
test("stale, future-dated, reset and failed readings never show current remaining", () => {
  const provider = codexSubscription({ rateLimits: bucket(20) }, {}, now);
  const entry = provider.windows[0];
  assert.equal(allowanceDisplay(provider, entry, now).value, 80);
  assert.equal(allowanceDisplay(provider, entry, now + 300001).value, null);
  assert.equal(allowanceDisplay(provider, entry, now - 1).value, null);
  assert.equal(
    allowanceDisplay(provider, { ...entry, resetsAt: now }, now).value,
    null,
  );
  assert.equal(
    allowanceDisplay({ ...provider, status: "unavailable" }, entry, now).value,
    null,
  );
});
async function fixture(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ocelin-subscriptions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "claude");
  await mkdir(home);
  const file = join(home, ".credentials.json");
  const credentials = {
    accessToken: "test-secret-never-publish",
    scopes: ["user:profile"],
    subscriptionType: "max",
    expiresAt: now + 600000,
    ...extra,
  };
  await writeFile(file, JSON.stringify({ claudeAiOauth: credentials }));
  return { dir, home, file, credentials };
}
test("Claude reads only fixed usage endpoint, never forwards credentials to cache", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const client = {
    async call(method) {
      return method === "account/read"
        ? { account: { type: "chatgpt", planType: "pro" } }
        : { rateLimits: bucket(92) };
    },
    stop() {},
  };
  const monitor = new SubscriptionMonitor({
    dataDir: f.dir,
    env: { CLAUDE_CONFIG_DIR: f.home },
    now: () => now,
    client,
    fetcher: async (url, args) => {
      calls++;
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      assert.equal(args.method, "GET");
      assert.equal(args.redirect, "error");
      assert.equal(
        args.headers.Authorization,
        `Bearer ${f.credentials.accessToken}`,
      );
      return new Response(
        JSON.stringify({
          seven_day: { utilization: 3, resets_at: null },
          accessToken: "do-not-forward",
        }),
      );
    },
  });
  await monitor.refresh();
  assert.equal(calls, 1);
  const raw = await readFile(join(f.dir, "subscriptions.json"), "utf8");
  assert.ok(
    !raw.includes("secret") &&
      !raw.includes("do-not-forward") &&
      !raw.includes("accessToken"),
  );
  assert.equal(
    (await readSubscriptionSnapshot(f.dir)).claude.windows[0].remainingPercent,
    97,
  );
});
test("expired credentials make no usage request", async (t) => {
  const f = await fixture(t, { expiresAt: now - 1 });
  const monitor = new SubscriptionMonitor({
    env: { CLAUDE_CONFIG_DIR: f.home },
    now: () => now,
    fetcher: () => {
      throw new Error("must not run");
    },
  });
  assert.match((await monitor.claude()).message, /expired/);
});
test("account switch during Codex request discards the previous account's quota", async () => {
  let reads = 0;
  const client = {
    async call(method) {
      return method === "account/read"
        ? { account: { type: "chatgpt", email: `${++reads}@example.test` } }
        : { rateLimits: bucket(92) };
    },
    stop() {},
  };
  const monitor = new SubscriptionMonitor({ client, now: () => now });
  assert.equal((await monitor.codex()).windows.length, 0);
});
test("Claude authentication rejection and credential changes discard quota", async (t) => {
  const f = await fixture(t);
  const monitor = new SubscriptionMonitor({
    env: { CLAUDE_CONFIG_DIR: f.home },
    now: () => now,
    fetcher: async () => new Response("secret in error body", { status: 401 }),
  });
  assert.equal((await monitor.claude()).windows.length, 0);
  monitor.fetcher = async () => {
    await writeFile(
      f.file,
      JSON.stringify({
        claudeAiOauth: { ...f.credentials, accessToken: "different" },
      }),
    );
    return new Response(JSON.stringify({ seven_day: { utilization: 3 } }));
  };
  assert.match((await monitor.claude()).message, /Account changed/);
});
test("cached data is field-allowlisted and malformed files are unavailable", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.dir, "subscriptions.json"),
    JSON.stringify({
      schemaVersion: 1,
      providers: {
        codex: {
          accessToken: "secret",
          windows: [
            { label: "Weekly", remainingPercent: "100", token: "secret" },
          ],
        },
      },
    }),
  );
  const value = await readSubscriptionSnapshot(f.dir);
  assert.ok(!JSON.stringify(value).includes("secret"));
  assert.equal(value.codex.windows[0].remainingPercent, null);
  await writeFile(join(f.dir, "subscriptions.json"), "{broken");
  assert.equal(
    (await readSubscriptionSnapshot(f.dir)).codex.status,
    "unavailable",
  );
});
