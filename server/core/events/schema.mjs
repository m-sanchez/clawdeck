// @ts-check
/**
 * Event envelope validation. The emitter already normalizes and redacts; the
 * panel only checks the envelope's shape before trusting an event into the
 * single-writer store. Kept intentionally permissive on optional fields.
 */

/** Normalized event names the projection understands (documentation + guard). */
export const KNOWN_EVENTS = new Set([
  "session.start",
  "session.end",
  "prompt.submit",
  "tool.pre",
  "tool.post",
  "subagent.start",
  "subagent.stop",
  "task.created",
  "task.completed",
  "compact.pre",
  "compact.post",
  "notify",
  "stop",
  "stopfailure",
  "cwd.changed",
  "permission.denied",
  "policy.denied",
]);

/** A ts more than this beyond `now` is rejected (clock skew / forgery guard). */
export const MAX_FUTURE_SKEW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * @param {any} evt
 * @param {{ now?: number, skewMs?: number }} [opts]
 * @returns {string|null} an error string, or null when the envelope is valid.
 */
export function validateEvent(evt, opts = {}) {
  if (!evt || typeof evt !== "object") return "not an object";
  if (evt.v !== 1) return "unsupported version";
  if (typeof evt.id !== "string" || !evt.id) return "missing id";
  if (typeof evt.ts !== "number" || !Number.isFinite(evt.ts)) return "bad ts";
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const skew =
    typeof opts.skewMs === "number" ? opts.skewMs : MAX_FUTURE_SKEW_MS;
  if (evt.ts > now + skew) return "ts too far in the future";
  if (typeof evt.event !== "string" || !evt.event) return "missing event";
  return null;
}

/** @param {any} evt */
export function isValidEvent(evt) {
  return validateEvent(evt) === null;
}
