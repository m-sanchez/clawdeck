// @ts-check
/**
 * Optional per-session policy state. A host project's own tooling may write
 * `.claude/.state/policy/<sessionId>.json` files; when present they are read
 * across the observed checkout and every worktree (newest updatedAt wins) to
 * show each session's workflow state. With no provider the map is empty.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** @param {string} root @param {Map<string,any>} out */
function readRoot(root, out) {
  const dir = join(root, ".claude", ".state", "policy");
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let pol;
    try {
      pol = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const sid = pol?.sessionId || name.replace(/\.json$/, "");
    const prev = out.get(sid);
    if (prev && Number(prev.updatedAt) >= Number(pol.updatedAt)) continue;
    out.set(sid, { ...pol, sessionId: sid });
  }
}

/**
 * @param {{ checkoutRoot: string }} ctx
 * @param {Array<{ path: string }>} worktrees
 * @returns {{ sessions: Record<string, any>, count: number }}
 */
export function getPolicy(ctx, worktrees) {
  const roots = new Set(
    [ctx.checkoutRoot, ...(worktrees || []).map((w) => w.path)].filter(Boolean),
  );
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const r of roots) readRoot(r, map);
  return { sessions: Object.fromEntries(map), count: map.size };
}
