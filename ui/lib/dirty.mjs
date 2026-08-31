// @ts-check
/**
 * Dirty-section arithmetic for snapshot-driven re-renders. Pure so it can be
 * unit-tested in Node. Fail-open everywhere: missing hash data means "assume
 * changed" - a stale view is a bug, a redundant render is not.
 */

/**
 * Which sections changed between two `byKey` hash maps. `null` means unknown
 * (first snapshot, or a server without section hashes): treat all as dirty.
 */
export function diffSections(prev, next) {
  if (!prev || !next) return null;
  const changed = new Set();
  for (const k of Object.keys(next)) if (prev[k] !== next[k]) changed.add(k);
  for (const k of Object.keys(prev)) if (!(k in next)) changed.add(k);
  return changed;
}

/**
 * Should the active view re-render for this snapshot? A dep that is not in
 * `byKey` is a deliberately unhashed (per-build volatile) section and always
 * forces a render.
 */
export function needsRender(deps, changed, byKey) {
  if (!deps || !changed || !byKey) return true;
  return deps.some((k) => changed.has(k) || !(k in byKey));
}
