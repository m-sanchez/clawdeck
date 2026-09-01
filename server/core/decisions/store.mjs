// @ts-check
/**
 * The Decision Ledger: why a change went the way it did, recorded once.
 *
 * A delivery is full of decisions that leave no trace - the reviewer's point
 * was declined, the flaky test was accepted, the refactor was deferred. Weeks
 * later the code shows what happened and nothing shows why.
 *
 * Claude may draft a decision. Only a person can mint one: `decidedBy` is
 * `"human"` or `"mechanical-policy"`, there is no third value, and no code path
 * reaches `"human"` without a human action carrying it. A draft that nobody
 * accepted is not in the ledger at all - it is not stored anywhere.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const DECIDED_BY = Object.freeze(["human", "mechanical-policy"]);
export const DECISION_CAP = 200;
const CHANGE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function decisionsDir(runtimeDir) {
  return join(runtimeDir, "decisions");
}
function filePath(runtimeDir, changeId) {
  return join(decisionsDir(runtimeDir), `${changeId}.json`);
}

/** Never throws: an unreadable ledger degrades to an empty one. */
export function readDecisions(runtimeDir, changeId) {
  if (!CHANGE_RE.test(String(changeId ?? ""))) return [];
  try {
    const raw = JSON.parse(
      readFileSync(filePath(runtimeDir, changeId), "utf8"),
    );
    return Array.isArray(raw?.decisions) ? raw.decisions : [];
  } catch {
    return [];
  }
}

function write(runtimeDir, changeId, decisions) {
  const dir = decisionsDir(runtimeDir);
  const file = filePath(runtimeDir, changeId);
  const payload = JSON.stringify(
    { version: 1, changeId, decisions: decisions.slice(-DECISION_CAP) },
    null,
    2,
  );
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, payload);
    try {
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, payload);
      rmSync(tmp, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a decision. Returns null when the input is not something a person
 * could have decided, so a malformed call writes nothing rather than half a
 * record.
 *
 * @param {string} runtimeDir
 * @param {string} changeId
 * @param {{decision:string, reason?:string, source?:object,
 *          evidence?:object[], rejectedAlternatives?:string[],
 *          decidedBy?:string, draftedBy?:string}} input
 * @param {{now?:number, id?:string}} [opts]
 */
export function recordDecision(runtimeDir, changeId, input, opts = {}) {
  if (!CHANGE_RE.test(String(changeId ?? ""))) return null;
  const decision = String(input?.decision ?? "").slice(0, 300);
  if (!decision) return null;
  // The authority must be stated. Defaulting an absent field to "human" would
  // be the soft path by which a call nobody made mints a human decision, so an
  // absent or unrecognised value is refused rather than coerced.
  const decidedBy = input?.decidedBy;
  if (!DECIDED_BY.includes(decidedBy)) return null;

  const now = new Date(opts.now ?? Date.now()).toISOString();
  const record = {
    id:
      opts.id ??
      `dec_${(readDecisions(runtimeDir, changeId).length + 1).toString().padStart(4, "0")}`,
    changeId,
    decision,
    reason: input.reason ? String(input.reason).slice(0, 1000) : null,
    source: input.source ?? null,
    evidence: (input.evidence || []).slice(0, 20),
    rejectedAlternatives: (input.rejectedAlternatives || [])
      .slice(0, 10)
      .map((a) => String(a).slice(0, 200)),
    decidedBy,
    // Provenance, not authority: a drafted decision is still the human's.
    draftedBy: input.draftedBy ? String(input.draftedBy).slice(0, 60) : null,
    createdAt: now,
  };
  const decisions = [...readDecisions(runtimeDir, changeId), record];
  if (!write(runtimeDir, changeId, decisions)) return null;
  return record;
}

/** Counts and the most recent few, for the snapshot. No reasons, no bodies. */
export function summarizeDecisions(runtimeDir, changeId, limit = 5) {
  const all = readDecisions(runtimeDir, changeId);
  return {
    total: all.length,
    recent: all
      .slice(-limit)
      .reverse()
      .map((d) => ({
        id: d.id,
        decision: d.decision,
        decidedBy: d.decidedBy,
        createdAt: d.createdAt,
      })),
  };
}
