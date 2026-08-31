// @ts-check
/**
 * Resolve and load existing repository modules by checkout-relative path, so the
 * adapters reuse the real worktree/loop/review code instead of duplicating it.
 * Loading is best-effort and cached: a checkout that predates a given module (or
 * a develop checkout without the worktree harness) simply degrades to null and
 * the adapter falls back to git-only facts.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
/** @type {Map<string, unknown>} */
const cache = new Map();

/** Dynamically import a repo ESM module relative to the checkout root, or null. */
export async function loadEsm(checkoutRoot, relativePath) {
  const key = `esm:${checkoutRoot}:${relativePath}`;
  if (cache.has(key)) return cache.get(key);
  const absolute = join(checkoutRoot, relativePath);
  let mod = null;
  if (existsSync(absolute)) {
    try {
      mod = await import(pathToFileURL(absolute).href);
    } catch {
      mod = null;
    }
  }
  cache.set(key, mod);
  return mod;
}

/** Require a repo CommonJS module relative to the checkout root, or null. */
export function loadCjs(checkoutRoot, relativePath) {
  const key = `cjs:${checkoutRoot}:${relativePath}`;
  if (cache.has(key)) return cache.get(key);
  const absolute = join(checkoutRoot, relativePath);
  let mod = null;
  if (existsSync(absolute)) {
    try {
      mod = require(absolute);
    } catch {
      mod = null;
    }
  }
  cache.set(key, mod);
  return mod;
}
