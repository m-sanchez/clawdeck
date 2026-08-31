// @ts-check
/**
 * Findings as first-class objects: a deterministic id (stable across re-scans so
 * a finding is the same object each time) and the lifecycle state machine. Pure,
 * dependency-free, so both the server and a node test use it. State persistence
 * and actions layer on top of this.
 */

/** Stable, dependency-free string hash (djb2). */
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Deterministic id from the finding's identity (file, line, rule, normalized
 * message). The same finding yields the same id on every scan, so a rejected or
 * resolved finding never reappears as new.
 * @param {any} f
 */
export function findingId(f) {
  const key = [
    f.file || "",
    f.line || "",
    f.ruleId || f.rule || "",
    String(f.title || f.message || "")
      .trim()
      .toLowerCase()
      .slice(0, 80),
  ].join("|");
  return "f_" + hashStr(key);
}

export const FINDING_STATES = [
  "found",
  "needs-verification",
  "confirmed",
  "rejected",
  "fix-dispatched",
  "changed",
  "targeted-test-passed",
  "reverify-required",
  "resolved",
];

// Minimal legal transition graph. A finding is only "resolved" after its fix
// is evidenced (changed) and verified (targeted-test-passed). Rejected and
// resolved can reopen (rejected -> found on an explicit reopen; resolved ->
// reverify-required when a fresh scan re-detects the same stable finding).
const NEXT = {
  found: ["needs-verification", "confirmed", "rejected"],
  "needs-verification": ["confirmed", "rejected"],
  confirmed: ["fix-dispatched", "rejected"],
  "fix-dispatched": ["changed", "confirmed"],
  changed: ["targeted-test-passed", "reverify-required", "confirmed"],
  "targeted-test-passed": ["resolved", "reverify-required"],
  "reverify-required": ["confirmed", "targeted-test-passed", "rejected"],
  rejected: ["found"],
  resolved: ["reverify-required"],
};

/** @param {string} from */
export function nextStates(from) {
  return NEXT[from] || [];
}

/** @param {string} from @param {string} to */
export function canTransition(from, to) {
  return (NEXT[from] || []).includes(to);
}
