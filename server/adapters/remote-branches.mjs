// @ts-check
/**
 * Remote-tracking branches already merged into the default branch (origin/HEAD)
 * but still present on origin: candidates to delete on the remote. Read-only and
 * derived from local remote-tracking refs (no network), so the list is only as
 * fresh as the last fetch. The panel never deletes anything; it surfaces the
 * branches and the exact `git push origin --delete` command.
 */
import { git } from "../lib/git.mjs";

const BASE_BRANCHES = new Set(["HEAD", "develop", "master", "main"]);

/**
 * @param {{ checkoutRoot: string }} ctx
 * @returns {Promise<{ total: number, branches: string[] }>}
 */
export async function getMergedRemoteBranches(ctx) {
  const out = await git(
    ["branch", "-r", "--merged", "origin/HEAD", "--format=%(refname:short)"],
    ctx.checkoutRoot,
  );
  if (!out) return { total: 0, branches: [] };
  const branches = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((b) => b.startsWith("origin/"))
    .map((b) => b.slice("origin/".length))
    .filter((b) => b && !BASE_BRANCHES.has(b))
    .sort((a, b) => a.localeCompare(b));
  return { total: branches.length, branches };
}
