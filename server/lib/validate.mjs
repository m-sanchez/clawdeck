// @ts-check
/**
 * Security validators for params that reach git on the read-only endpoints. Pure
 * and unit-tested, so the path-traversal defenses can't silently regress.
 */

/** A repo-relative file path safe to pass as a `git -- <path>` pathspec. */
export function isSafeRelativeFile(file) {
  const f = String(file ?? "");
  if (!f) return false;
  if (f.includes("..")) return false; // no parent-dir escape
  if (/^([/\\]|[a-zA-Z]:)/.test(f)) return false; // no absolute / drive-letter
  return true;
}

/** A git ref/branch name safe to interpolate into a revision range. */
export function isSafeRef(ref) {
  const r = String(ref ?? "");
  return /^[\w.\-/]+$/.test(r) && !r.includes("..");
}
