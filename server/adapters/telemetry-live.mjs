// @ts-check
/**
 * Live per-session cost/context telemetry written by the statusline bridge to
 * each checkout's `.claude/.runtime/telemetry/sessions/<sessionId>.json`. Read
 * across the panel's own checkout and every worktree, newest sample per session
 * id wins.
 *
 * "Live" means fresh: a session whose newest sample is older than the live
 * window (or explicitly ended) is NOT part of the live spend number, but it is
 * still returned in `sessions` for the historical view. The cost value is the
 * statusline `cost.total_cost_usd`, which Claude Code documents as an ESTIMATE
 * of API-equivalent cost — never confirmed billed spend (see rollup labels).
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Default live window: a sample older than this no longer counts as live. */
export const LIVE_WINDOW_MS = 15 * 60 * 1000;

/** Retention for session records, matching the event and OTEL day files. */
export const SESSION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Delete session records older than the retention window. Every other telemetry
 * store rotates; these files accumulated for the life of the checkout.
 * @returns {{ removed: number }}
 */
export function pruneSessionRecords(roots, now = Date.now(), opts = {}) {
  const maxAgeMs =
    Number(opts.maxAgeMs) > 0 ? Number(opts.maxAgeMs) : SESSION_RETENTION_MS;
  let removed = 0;
  for (const root of new Set((roots || []).filter(Boolean))) {
    const dir = join(root, ".claude", ".runtime", "telemetry", "sessions");
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = join(dir, name);
      let ts = 0;
      try {
        ts = Number(JSON.parse(readFileSync(file, "utf8"))?.ts) || 0;
      } catch {
        continue; // unreadable: leave it alone rather than delete blind
      }
      // ts 0 means the record never carried a timestamp; keep it, since age is
      // unknown and deleting on "unknown" is how histories disappear.
      if (!ts || now - ts <= maxAgeMs) continue;
      try {
        rmSync(file, { force: true });
        removed++;
      } catch {
        /* locked or already gone */
      }
    }
  }
  return { removed };
}

/** @param {string} root @param {Map<string,any>} out @param {number} now */
function readRoot(root, out, now) {
  const dir = join(root, ".claude", ".runtime", "telemetry", "sessions");
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return; // dir absent -> no sessions from this root
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue; // skip a partially-written or corrupt record
    }
    const sessionId = rec?.sessionId || name.replace(/\.json$/, "");
    const ts = Number(rec?.ts) || 0;
    const prev = out.get(sessionId);
    if (prev && Number(prev.ts) >= ts) continue;
    out.set(sessionId, { ...rec, sessionId, ageMs: ts ? now - ts : null });
  }
}

/**
 * @param {{ checkoutRoot: string }} ctx
 * @param {Array<{ path: string }>} worktrees
 * @param {number} [now]
 * @param {{ liveWindowMs?: number }} [opts]
 * @returns {{ sessions: Record<string, any>, live: Record<string, any>,
 *   count: number, liveCount: number, historicalCount: number,
 *   sumLiveCostUsd: number, sumSessionCostUsd: number,
 *   estimated: true, costSource: string, liveWindowMs: number }}
 */
export function getLiveTelemetry(ctx, worktrees, now = Date.now(), opts = {}) {
  const liveWindowMs = Number(opts.liveWindowMs) || LIVE_WINDOW_MS;
  const roots = new Set(
    [ctx.checkoutRoot, ...(worktrees || []).map((w) => w.path)].filter(Boolean),
  );
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const r of roots) readRoot(r, map, now);

  const sessions = {};
  const live = {};
  let sumLive = 0;
  for (const [id, rec] of map) {
    // Fresh = within the window AND not future-dated. A negative age (sample ts
    // ahead of now, e.g. a backward clock step) must not pin a session "live".
    const fresh =
      rec.ended !== true &&
      rec.ageMs != null &&
      rec.ageMs >= 0 &&
      rec.ageMs <= liveWindowMs;
    rec.stale = !fresh;
    sessions[id] = rec;
    if (fresh) {
      live[id] = rec;
      sumLive += Number(rec.costUsd) || 0;
    }
  }
  const round = (n) => Math.round(n * 1e6) / 1e6;
  return {
    sessions,
    live,
    count: Object.keys(live).length, // back-compat: "count" == live count
    liveCount: Object.keys(live).length,
    historicalCount: map.size,
    sumLiveCostUsd: round(sumLive),
    sumSessionCostUsd: round(sumLive), // back-compat alias, now live-only
    estimated: true,
    costSource: "statusline cost.total_cost_usd (estimated API-equivalent)",
    liveWindowMs,
  };
}
