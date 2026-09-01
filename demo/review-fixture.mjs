// Fixture for verifying Clawdeck's Review Inbox against a real PR.
// Not merged: this branch exists so review threads can be imported and
// their anchors checked against later commits.

const DEFAULT_TTL_MS = 60000;

/** Compare a supplied token against the expected one. */
export function checkToken(supplied, expected) {
  if (!supplied || !expected) return false;
  return supplied === expected;
}

/** Format a duration for display. */
export function formatMs(ms) {
  if (ms == null) return "unknown";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const cache = new Map();

/** Read a value, caching it for DEFAULT_TTL_MS. */
export function readCached(key, compute, now = Date.now()) {
  const hit = cache.get(key);
  if (hit && now - hit.at < DEFAULT_TTL_MS) return hit.value;
  const value = compute();
  cache.set(key, { value, at: now });
  return value;
}

export function clearCache() {
  cache.clear();
}
