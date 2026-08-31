// @ts-check
/**
 * Per-section content hashes for the snapshot so clients can skip re-render
 * work when a section did not change, and so /api/snapshot can answer 304.
 *
 * FNV-1a over each section's JSON: fast, dependency-free, and stable because
 * the builder emits keys in a fixed order. A change detector, nothing more -
 * never a security boundary.
 *
 * Sections that advance with time rather than content (process uptime,
 * sample timestamps, the self-appending activity series) are excluded:
 * hashing them would make every build "changed" and the ETag useless. A
 * client view that depends on an unhashed section must treat it as always
 * dirty.
 */

const UNHASHED = new Set(["emittedAt", "sections", "panel", "perf", "history"]);

/** 32-bit FNV-1a of a string, as 8 hex chars. */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * `{ version, byKey }` for a snapshot-shaped object. `byKey` holds one hash
 * per hashed top-level section; `version` digests them all, so it is stable
 * across builds whenever no content section changed.
 */
export function sectionHashes(snapshot) {
  const byKey = {};
  const keys = Object.keys(snapshot || {})
    .filter((k) => !UNHASHED.has(k))
    .sort();
  let acc = "";
  for (const key of keys) {
    const h = fnv1a(JSON.stringify(snapshot[key]) ?? "");
    byKey[key] = h;
    acc += `${key}:${h};`;
  }
  return { version: fnv1a(acc), byKey };
}
