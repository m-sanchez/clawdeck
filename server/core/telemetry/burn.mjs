// @ts-check
/**
 * Burn rate + limit forecasting from the statusline telemetry.
 *
 * Two different measurements, kept honestly separate:
 *  - $/hour and the monthly projection come from differencing each session's
 *    CUMULATIVE estimated costUsd (`costSource`).
 *  - 5h/7d depletion comes from the harness's own rate-limit percentages
 *    (`quotaSource`); the slope is computed only within one reset epoch so a
 *    92%→4% reset never reads as negative burn.
 *
 * Samples key on each telemetry record's own ts: re-reading an unchanged
 * record appends nothing, so idle time yields absence (the "no data since T"
 * signal), never zeros. History persists in the panel's runtime dir with the
 * capped tmp+rename pattern.
 */
import { readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isoFromEpochSeconds } from "./quota-pressure.mjs";

export const BURN_SAMPLE_CAP = 2880; // 48h at one per minute
export const RATE_WINDOW_MS = 30 * 60 * 1000;
export const MIN_PROJECTION_COVERAGE_H = 6;
export const BURN_STALE_MS = 15 * 60 * 1000;
export const COST_SOURCE =
  "statusline cost.total_cost_usd deltas (estimated API-equivalent, not billed)";
export const QUOTA_BURN_SOURCE =
  "statusline rate_limits percentages (harness-provided)";

export function burnHistoryPath(runtimeDir) {
  return join(runtimeDir, "burn-history.json");
}

/** @returns {{ samples: any[], baselines: Record<string, {ts:number, costUsd:number}> }} */
export function readBurnHistory(runtimeDir) {
  try {
    const parsed = JSON.parse(
      readFileSync(burnHistoryPath(runtimeDir), "utf8"),
    );
    return {
      samples: Array.isArray(parsed?.samples) ? parsed.samples : [],
      baselines:
        parsed?.baselines && typeof parsed.baselines === "object"
          ? parsed.baselines
          : {},
    };
  } catch {
    return { samples: [], baselines: {} };
  }
}

function writeBurnHistory(runtimeDir, history) {
  const path = burnHistoryPath(runtimeDir);
  const tmp = path + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(history));
    try {
      renameSync(tmp, path);
    } catch {
      // Windows refuses rename-over-existing under contention; last write wins.
      if (existsSync(path)) writeFileSync(path, JSON.stringify(history));
      else throw new Error("rename failed");
    }
  } catch {
    /* best-effort persistence; aggregates recompute from what survives */
  }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Fold the current telemetry records into the persisted history. Only records
 * with a ts NEWER than their session baseline contribute; nothing new means
 * nothing appended.
 * @param {string} runtimeDir
 * @param {Record<string, any>|any[]} sessions statusline records
 * @param {number} [now]
 * @returns {{ appended: boolean }}
 */
export function recordBurnSample(runtimeDir, sessions, now = Date.now()) {
  const records = Array.isArray(sessions)
    ? sessions
    : sessions && typeof sessions === "object"
      ? Object.values(sessions)
      : [];
  const history = readBurnHistory(runtimeDir);
  let usd = 0;
  let sawNew = false;
  let newestSrcTs = 0;
  let quota = null;

  for (const rec of records) {
    const sid = rec?.sessionId;
    const ts = num(rec?.ts);
    if (!sid || ts == null || ts <= 0) continue;
    const base = history.baselines[sid];
    if (base && ts <= base.ts) continue; // unchanged record: not a sample
    sawNew = true;
    newestSrcTs = Math.max(newestSrcTs, ts);

    const cost = num(rec.costUsd);
    if (cost != null) {
      const prev = base ? base.costUsd : null;
      // First sighting establishes the baseline without attributing the whole
      // cumulative total to this minute; a drop means the counter restarted.
      const delta = prev == null ? 0 : cost - prev;
      if (delta > 0) usd += delta;
      history.baselines[sid] = { ts, costUsd: cost };
    } else {
      history.baselines[sid] = { ts, costUsd: base?.costUsd ?? 0 };
    }
    const rl = rec.rateLimits;
    if (
      rl &&
      (num(rl.fiveHourPct) != null || num(rl.sevenDayPct) != null) &&
      (!quota || ts > quota.srcTs)
    ) {
      quota = {
        srcTs: ts,
        fiveHourPct: num(rl.fiveHourPct),
        fiveHourResetsAt: num(rl.fiveHourResetsAt),
        sevenDayPct: num(rl.sevenDayPct),
        sevenDayResetsAt: num(rl.sevenDayResetsAt),
      };
    }
  }

  if (!sawNew) return { appended: false };
  history.samples.push({
    t: now,
    usd: Math.round(usd * 1e6) / 1e6,
    srcTs: newestSrcTs,
    fiveHourPct: quota?.fiveHourPct ?? null,
    fiveHourResetsAt: quota?.fiveHourResetsAt ?? null,
    sevenDayPct: quota?.sevenDayPct ?? null,
    sevenDayResetsAt: quota?.sevenDayResetsAt ?? null,
  });
  if (history.samples.length > BURN_SAMPLE_CAP)
    history.samples = history.samples.slice(-BURN_SAMPLE_CAP);
  writeBurnHistory(runtimeDir, history);
  return { appended: true };
}

/**
 * Slope of a quota window in pct/hour using only the newest reset epoch, plus
 * the ETA to 100% at that slope (null when the reset arrives first).
 */
function quotaForecast(
  samples,
  pctKey,
  resetKey,
  quotaPressure,
  qpPctKey,
  qpResetKey,
  now,
) {
  const carrying = samples.filter((s) => s[pctKey] != null);
  // Newest epoch = trailing run with the same resetsAt (or, when resetsAt is
  // absent, a run where pct never drops sharply — a drop marks a reset).
  const epoch = [];
  for (let i = carrying.length - 1; i >= 0; i--) {
    const s = carrying[i];
    const next = epoch[0];
    if (next) {
      const resetChanged =
        s[resetKey] != null &&
        next[resetKey] != null &&
        s[resetKey] !== next[resetKey];
      const pctDropped = next[pctKey] < s[pctKey] - 1; // later sample far lower = reset between
      if (resetChanged || pctDropped) break;
    }
    epoch.unshift(s);
  }
  const usedPct = quotaPressure?.[qpPctKey] ?? epoch.at(-1)?.[pctKey] ?? null;
  const resetsAt =
    quotaPressure?.[qpResetKey] ??
    isoFromEpochSeconds(epoch.at(-1)?.[resetKey]) ??
    null;

  let burnPctPerHour = null;
  let etaToLimit = null;
  if (epoch.length >= 2) {
    const first = epoch[0];
    const last = epoch.at(-1);
    const dtH = (last.t - first.t) / 3600000;
    if (dtH > 0) {
      const slope = (last[pctKey] - first[pctKey]) / dtH;
      burnPctPerHour = Math.round(slope * 100) / 100;
      if (slope > 0 && usedPct != null && usedPct < 100) {
        const hitMs = now + ((100 - usedPct) / slope) * 3600000;
        const resetMs = resetsAt ? Date.parse(resetsAt) : null;
        if (resetMs == null || hitMs <= resetMs)
          etaToLimit = new Date(hitMs).toISOString();
      }
    }
  }
  return { usedPct, resetsAt, burnPctPerHour, etaToLimit };
}

/**
 * @param {{ samples: any[] }} history
 * @param {object|null} quotaPressure fresh quota reading (may be stale-flagged)
 * @param {number} [now]
 */
export function computeBurn(history, quotaPressure, now = Date.now()) {
  const samples = history?.samples ?? [];
  const qp = quotaPressure && !quotaPressure.stale ? quotaPressure : null;

  const inWindow = samples.filter((s) => now - s.t <= RATE_WINDOW_MS);
  const windowUsd = inWindow.reduce((a, s) => a + (s.usd || 0), 0);
  const perHourUsd = inWindow.length
    ? Math.round(windowUsd * (3600000 / RATE_WINDOW_MS) * 1e4) / 1e4
    : null;

  let projectedMonthUsd = null;
  let coverageHours = 0;
  if (samples.length >= 2) {
    coverageHours =
      Math.round(((samples.at(-1).t - samples[0].t) / 3600000) * 10) / 10;
    if (coverageHours >= MIN_PROJECTION_COVERAGE_H) {
      const totalUsd = samples.reduce((a, s) => a + (s.usd || 0), 0);
      const daysInMonth = new Date(
        new Date(now).getFullYear(),
        new Date(now).getMonth() + 1,
        0,
      ).getDate();
      projectedMonthUsd =
        Math.round((totalUsd / coverageHours) * 24 * daysInMonth * 100) / 100;
    }
  }

  // Five-minute buckets for the sparkline (at most 72 = 6h).
  const bucketMs = 5 * 60 * 1000;
  const buckets = new Map();
  for (const s of samples) {
    if (now - s.t > 72 * bucketMs) continue;
    const b = Math.floor(s.t / bucketMs) * bucketMs;
    buckets.set(b, (buckets.get(b) || 0) + (s.usd || 0));
  }
  const series = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, usd]) => ({ t, usd: Math.round(usd * 1e6) / 1e6 }));

  const newest = samples.at(-1) ?? null;
  const sampledAt = newest
    ? new Date(newest.srcTs || newest.t).toISOString()
    : null;
  const stale =
    newest == null || now - (newest.srcTs || newest.t) > BURN_STALE_MS;

  return {
    perHourUsd,
    windowMinutes: RATE_WINDOW_MS / 60000,
    fiveHour: quotaForecast(
      samples,
      "fiveHourPct",
      "fiveHourResetsAt",
      qp,
      "fiveHourPct",
      "fiveHourResetsAt",
      now,
    ),
    sevenDay: quotaForecast(
      samples,
      "sevenDayPct",
      "sevenDayResetsAt",
      qp,
      "sevenDayPct",
      "sevenDayResetsAt",
      now,
    ),
    projectedMonthUsd,
    coverageHours,
    samples: series,
    sampledAt,
    stale,
    estimated: true,
    costSource: COST_SOURCE,
    quotaSource: QUOTA_BURN_SOURCE,
  };
}
