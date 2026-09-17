import { readFile, stat, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { CodexClient } from "../library/codex-client.mjs";

export const SUBSCRIPTION_INTERVAL = 120000;
export const SUBSCRIPTION_TTL = 300000;
export const subscriptionDirectory = () =>
  process.env.OCELIN_DATA_DIR ||
  join(
    process.env.LOCALAPPDATA || join(homedir(), ".local", "share"),
    "Ocelin",
  );
const percent = (value) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100
    ? value
    : null;
const safeText = (value) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100)
    : null;
const reset = (value) => {
  const time =
    typeof value === "number"
      ? value * 1000
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(time) && time > 0 && time < 8.64e15 ? time : null;
};
const empty = (provider, message = "Checking subscription…") => ({
  provider,
  status: "unavailable",
  message,
  sampledAt: null,
  windows: [],
  plan: null,
});
export const emptySubscriptions = () => ({
  codex: empty("codex"),
  claude: empty("claude"),
});
const window = (id, label, used, resetsAt, minutes) => ({
  id,
  label,
  remainingPercent:
    percent(used) == null ? null : Math.round((100 - used) * 10) / 10,
  resetsAt: reset(resetsAt),
  minutes,
});
const duration = (minutes) =>
  minutes === 300
    ? "Session · 5h"
    : minutes === 10080
      ? "Weekly"
      : minutes > 0
        ? `${minutes} min`
        : "Allowance";

export function codexSubscription(result, account, now = Date.now()) {
  const buckets =
    result?.rateLimitsByLimitId &&
    typeof result.rateLimitsByLimitId === "object"
      ? result.rateLimitsByLimitId
      : result?.rateLimits
        ? { [result.rateLimits.limitId || "codex"]: result.rateLimits }
        : {};
  const windows = [];
  for (const [id, bucket] of Object.entries(buckets).slice(0, 12)) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const key of ["primary", "secondary"]) {
      const value = bucket[key];
      if (!value || typeof value !== "object") continue;
      const minutes = Number.isFinite(value.windowDurationMins)
        ? value.windowDurationMins
        : null;
      const label = `${id === "codex" ? "" : `${safeText(bucket.limitName) || safeText(id)} · `}${duration(minutes)}`;
      windows.push({
        ...window(
          `${id}:${key}`,
          label,
          value.usedPercent,
          value.resetsAt,
          minutes,
        ),
        extra: id !== "codex",
      });
    }
  }
  return {
    provider: "codex",
    status: windows.length ? "ready" : "unavailable",
    message: windows.length
      ? null
      : "Codex did not report subscription limits.",
    sampledAt: now,
    plan: safeText(account?.planType || result?.rateLimits?.planType),
    source: "Codex sign-in",
    windows,
  };
}

export function claudeSubscription(result, plan, now = Date.now()) {
  const labels = {
    five_hour: "Session · 5h",
    seven_day: "Weekly",
    seven_day_opus: "Opus · weekly",
    seven_day_sonnet: "Sonnet · weekly",
    seven_day_oauth_apps: "Connected apps · weekly",
    seven_day_cowork: "Cowork · weekly",
  };
  const windows = [];
  for (const [key, value] of Object.entries(result || {})) {
    if (
      !/^(five_hour|seven_day(?:_[a-z0-9_]+)?)$/.test(key) ||
      !value ||
      typeof value !== "object" ||
      !("utilization" in value)
    )
      continue;
    windows.push({
      ...window(
        key,
        labels[key] ||
          `${key.replace(/^seven_day_/, "").replaceAll("_", " ")} · weekly`,
        value.utilization,
        value.resets_at,
        key === "five_hour" ? 300 : 10080,
      ),
      extra: !["five_hour", "seven_day"].includes(key),
    });
    if (windows.length === 12) break;
  }
  return {
    provider: "claude",
    status: windows.length ? "ready" : "unavailable",
    message: windows.length
      ? null
      : "Claude did not report subscription limits.",
    sampledAt: now,
    plan: safeText(plan),
    source: "Claude Code sign-in",
    windows,
  };
}

async function boundedJson(file) {
  if ((await stat(file)).size > 128 * 1024) throw new Error("File too large");
  return JSON.parse(await readFile(file, "utf8"));
}

export async function readSubscriptionSnapshot(
  directory = subscriptionDirectory(),
) {
  try {
    const value = await boundedJson(join(directory, "subscriptions.json"));
    if (value.schemaVersion !== 1) return emptySubscriptions();
    return Object.fromEntries(
      ["codex", "claude"].map((provider) => {
        const saved = value.providers?.[provider];
        if (!saved || !Array.isArray(saved.windows))
          return [provider, empty(provider)];
        return [
          provider,
          {
            provider,
            status: saved.status === "ready" ? "ready" : "unavailable",
            message: safeText(saved.message),
            plan: safeText(saved.plan),
            source: safeText(saved.source),
            sampledAt: Number.isFinite(saved.sampledAt)
              ? saved.sampledAt
              : null,
            windows: saved.windows
              .slice(0, 12)
              .filter((w) => w && typeof w === "object")
              .map((w) => ({
                id: safeText(w.id),
                label: safeText(w.label),
                remainingPercent: percent(w.remainingPercent),
                resetsAt:
                  Number.isFinite(w.resetsAt) &&
                  w.resetsAt > 0 &&
                  w.resetsAt < 8.64e15
                    ? w.resetsAt
                    : null,
                minutes: Number.isFinite(w.minutes) ? w.minutes : null,
                extra: w.extra === true,
              })),
          },
        ];
      }),
    );
  } catch {
    return emptySubscriptions();
  }
}

export class SubscriptionMonitor {
  constructor({
    dataDir = subscriptionDirectory(),
    env = process.env,
    now = Date.now,
    fetcher = fetch,
    client = new CodexClient({ env, timeout: 45000 }),
    onUpdate = () => {},
    fixture = false,
  } = {}) {
    Object.assign(this, {
      dataDir,
      env,
      now,
      fetcher,
      client,
      onUpdate,
      fixture,
    });
    this.value = emptySubscriptions();
  }
  async codex() {
    try {
      const before = await this.client.call("account/read", {
        refreshToken: false,
      });
      if (
        !before?.account ||
        !["chatgpt", "chatgptAuthTokens"].includes(before.account.type)
      )
        return empty("codex", "Sign in to a ChatGPT subscription in Codex.");
      const result = await this.client.call("account/rateLimits/read", {});
      const after = await this.client.call("account/read", {
        refreshToken: false,
      });
      if (JSON.stringify(before.account) !== JSON.stringify(after.account))
        return empty("codex", "Account changed. Checking again shortly.");
      return codexSubscription(result, after.account, this.now());
    } catch {
      return empty(
        "codex",
        "Cannot read Codex allowance. Open Codex and check its sign-in.",
      );
    } finally {
      this.client.stop();
    }
  }
  async claude() {
    try {
      const file = join(
        this.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
        ".credentials.json",
      );
      const credentials = (await boundedJson(file)).claudeAiOauth;
      if (
        !credentials?.accessToken ||
        !credentials.scopes?.includes("user:profile")
      )
        return empty(
          "claude",
          "Sign in to Claude Code with your subscription to read allowance.",
        );
      if (credentials.expiresAt && credentials.expiresAt <= this.now())
        return empty(
          "claude",
          "Claude sign-in expired. Open Claude Code to refresh it.",
        );
      const response = await this.fetcher(
        "https://api.anthropic.com/api/oauth/usage",
        {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "Ocelin/0.6.3",
          },
        },
      );
      if (!response.ok)
        return empty(
          "claude",
          response.status === 429
            ? "Claude usage is temporarily rate-limited. Retrying shortly."
            : "Claude usage unavailable. Check your Claude Code sign-in.",
        );
      const body = await response.text();
      if (body.length > 128 * 1024) throw new Error("Response too large");
      const current = (await boundedJson(file)).claudeAiOauth;
      if (current?.accessToken !== credentials.accessToken)
        return empty("claude", "Account changed. Checking again shortly.");
      return claudeSubscription(
        JSON.parse(body),
        credentials.subscriptionType,
        this.now(),
      );
    } catch {
      return empty(
        "claude",
        "Cannot read Claude allowance. Check your connection and Claude Code sign-in.",
      );
    }
  }
  async refresh() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      if (this.fixture)
        this.value = await readSubscriptionSnapshot(this.dataDir);
      else {
        await Promise.all(
          ["codex", "claude"].map(async (provider) => {
            const value = await this[provider]();
            if (!this.stopped) {
              this.value[provider] = value;
              this.onUpdate(this.value);
            }
          }),
        );
        if (this.stopped) return;
        await mkdir(this.dataDir, { recursive: true });
        const file = join(this.dataDir, "subscriptions.json");
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(
          temp,
          JSON.stringify({ schemaVersion: 1, providers: this.value }),
          { mode: 0o600 },
        );
        await rename(temp, file);
      }
      if (!this.stopped) this.onUpdate(this.value);
    })()
      .catch(() => {})
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  start() {
    this.stopped = false;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), SUBSCRIPTION_INTERVAL);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.client.stop();
  }
}
