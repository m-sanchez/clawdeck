// @ts-check
/**
 * Max-plan quota pressure, derived from the rate-limit percentages Claude Code
 * hands the statusline. Informational only: no routing decision and no gate
 * reads this. It answers "how much of the current window is used", which is a
 * different question from the API-equivalent cost rollup next to it.
 *
 * One sample decides the whole object. Windows are never mixed across samples,
 * because two sessions sampled minutes apart would otherwise be presented as one
 * coherent reading. Absent data is `unknown`, never zero.
 */

/** A sample older than this is reported but never banded. */
export const QUOTA_TTL_MS = 15 * 60 * 1000;

const GREEN_BELOW = 60;
const RED_ABOVE = 85;

export const QUOTA_SOURCE = "statusline rate_limits (heurística informativa)";

/** A percentage in 0..100, or null. */
function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** Epoch SECONDS from the harness -> ISO-8601 UTC, or null. */
function isoFromEpochSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

const EMPTY = {
  fiveHourPct: null,
  fiveHourResetsAt: null,
  sevenDayPct: null,
  sevenDayResetsAt: null,
  sampledAt: null,
  stale: false,
  band: /** @type {const} */ ("unknown"),
  source: QUOTA_SOURCE,
};

/** Worst band across the windows that are present. */
function bandFor(values) {
  const present = values.filter((v) => v != null);
  if (!present.length) return "unknown";
  const worst = Math.max(...present);
  if (worst > RED_ABOVE) return "red";
  if (worst >= GREEN_BELOW) return "amber";
  return "green";
}

/**
 * @param {Record<string, any>|Iterable<any>} sessions statusline records
 * @param {number} now
 * @param {{ ttlMs?: number }} [opts]
 */
export function computeQuotaPressure(sessions, now = Date.now(), opts = {}) {
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : QUOTA_TTL_MS;
  const records = Array.isArray(sessions)
    ? sessions
    : sessions && typeof sessions === "object"
      ? Object.values(sessions)
      : [];

  // The newest record that actually carries a rate-limit reading. A record
  // without one cannot mask an older record that has one.
  let chosen = null;
  for (const rec of records) {
    const rl = rec && rec.rateLimits;
    if (!rl) continue;
    if (pct(rl.fiveHourPct) == null && pct(rl.sevenDayPct) == null) continue;
    const ts = Number(rec.ts);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (!chosen || ts > Number(chosen.ts)) chosen = rec;
  }
  if (!chosen) return { ...EMPTY };

  const rl = chosen.rateLimits;
  const fiveHourPct = pct(rl.fiveHourPct);
  const sevenDayPct = pct(rl.sevenDayPct);
  const sampledAt = Number(chosen.ts);
  const age = now - sampledAt;
  // A future-dated sample is as untrustworthy as an expired one.
  const stale = age < 0 || age > ttlMs;

  return {
    fiveHourPct,
    fiveHourResetsAt: isoFromEpochSeconds(rl.fiveHourResetsAt),
    sevenDayPct,
    sevenDayResetsAt: isoFromEpochSeconds(rl.sevenDayResetsAt),
    sampledAt,
    stale,
    band: stale ? "unknown" : bandFor([fiveHourPct, sevenDayPct]),
    source: QUOTA_SOURCE,
  };
}
