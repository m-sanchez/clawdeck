// @ts-check
/**
 * Commits-per-day on the current checkout's HEAD over a recent window. Read-only
 * `git log`, bucketed by local commit date and zero-filled so the series has one
 * point per day (a flat run of zeros reads as "no commits that day", not a gap).
 */
import { git } from "../lib/git.mjs";

const DAY_MS = 86400000;

/** Local YYYY-MM-DD, matching git's `--date=short` (also local). */
function localKey(ms) {
  return new Date(ms).toLocaleDateString("en-CA");
}

/**
 * @param {{ checkoutRoot: string }} ctx
 * @param {number} [days]
 * @returns {Promise<{ date: string, count: number }[]>}
 */
export async function getCommitActivity(ctx, days = 14) {
  const n = Math.max(1, Math.min(90, Number(days) || 14));
  const out = await git(
    ["log", `--since=${n}.days`, "--format=%cd", "--date=short", "HEAD"],
    ctx.checkoutRoot,
  );
  const counts = new Map();
  if (out)
    for (const line of out.split(/\r?\n/)) {
      const d = line.trim();
      if (d) counts.set(d, (counts.get(d) || 0) + 1);
    }
  const today = Date.now();
  const result = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = localKey(today - i * DAY_MS);
    result.push({ date: key, count: counts.get(key) || 0 });
  }
  return result;
}
