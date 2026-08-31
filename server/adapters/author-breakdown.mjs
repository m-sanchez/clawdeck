// @ts-check
/**
 * Commit author breakdown for the current branch (commits since its merge-base
 * with the default branch). Read-only `git log`, counted per author. Returns []
 * when the merge-base cannot be resolved, so we never accidentally count the
 * entire repo history.
 */
import { git } from "../lib/git.mjs";

/**
 * @param {{ checkoutRoot: string }} ctx
 * @returns {Promise<{ author: string, count: number }[]>}
 */
export async function getAuthorBreakdown(ctx) {
  const base = (
    await git(["merge-base", "origin/HEAD", "HEAD"], ctx.checkoutRoot)
  )?.trim();
  if (!base) return [];
  const out = await git(
    ["log", `${base}..HEAD`, "--no-merges", "--format=%an"],
    ctx.checkoutRoot,
  );
  const counts = new Map();
  if (out)
    for (const line of out.split(/\r?\n/)) {
      const a = line.trim();
      if (a) counts.set(a, (counts.get(a) || 0) + 1);
    }
  return [...counts.entries()]
    .map(([author, count]) => ({ author, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}
