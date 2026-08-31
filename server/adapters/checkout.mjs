// @ts-check
/**
 * Checkout adapter, branch/commit/working-tree facts for the current checkout.
 * @typedef {import('../../../contracts/panel-protocol').PanelSnapshot['checkout']} CheckoutInfo
 */
import { git } from "../lib/git.mjs";

/**
 * @param {{ checkoutId: string, checkoutRoot: string, repoRoot: string }} ctx
 * @returns {Promise<CheckoutInfo & { commit: string|null, dirty: boolean, ahead: number, behind: number, dirtyCount: number }>}
 */
export async function getCheckout(ctx) {
  const root = ctx.checkoutRoot;
  const [branch, commit, status, upstream] = await Promise.all([
    git(["branch", "--show-current"], root),
    git(["rev-parse", "--short", "HEAD"], root),
    git(["status", "--porcelain"], root),
    git(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      root,
    ),
  ]);

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await git(
      ["rev-list", "--left-right", "--count", `${upstream}...HEAD`],
      root,
    );
    const [b, a] = counts.split(/\s+/).map((n) => Number(n) || 0);
    behind = b || 0;
    ahead = a || 0;
  }

  const dirtyLines = status ? status.split(/\r?\n/).filter(Boolean) : [];
  return {
    id: ctx.checkoutId,
    root,
    branch: branch || undefined,
    isWorktree: ctx.checkoutRoot !== ctx.repoRoot,
    commit: commit || null,
    dirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    ahead,
    behind,
  };
}
