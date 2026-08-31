// @ts-check
/**
 * Durable Fix Station lifecycle store. Each finding is a persistent operational
 * object keyed by its stable findingId, so its state (found ... resolved)
 * survives a panel restart and can be correlated with the fix session/commit
 * that changed it. A rescan reconciles against the existing records rather than
 * duplicating them: a re-detected finding keeps its state, a disappeared
 * confirmed/dispatched finding advances to "changed" (evidence its source was
 * touched), and a re-detected resolved finding reopens to reverify-required.
 *
 * Only lifecycle + small correlation metadata is stored — never the finding's
 * full review body (which the scan re-derives).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { findingId, canTransition } from "./model.mjs";

function storePath(runtimeDir) {
  return join(runtimeDir, "findings", "lifecycle.json");
}

/** Read the persisted lifecycle map (findingId -> record). Never throws. */
export function readFindingStore(runtimeDir) {
  try {
    const data = JSON.parse(readFileSync(storePath(runtimeDir), "utf8"));
    return data && typeof data === "object" && data.findings
      ? data
      : { v: 1, findings: {} };
  } catch {
    return { v: 1, findings: {} };
  }
}

export function writeFindingStore(runtimeDir, store) {
  const dir = join(runtimeDir, "findings");
  mkdirSync(dir, { recursive: true });
  const file = storePath(runtimeDir);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store));
  try {
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, JSON.stringify(store));
  }
  return store;
}

const APPEND_MAX = 40;
function appendHistory(rec, entry) {
  rec.history = [...(rec.history || []), entry].slice(-APPEND_MAX);
}

/** Small, non-duplicative metadata captured from a scanned finding. */
function metaOf(f) {
  return {
    severity: f.severity || (f.blocking ? "block" : "warn"),
    ruleId: f.ruleId || f.rule || null,
    file: f.file || null,
    line: f.line ?? null,
    title: (f.title || f.message || "").slice(0, 160),
    confidence: f.confidence ?? null,
    sourceReview: f.sourceReview || f.source || null,
    worktree: f.worktree || null,
  };
}

/**
 * Reconcile the persisted store against a fresh scan. Pure over its inputs
 * except for the `now` clock. Returns { store, changed } — `changed` is true
 * when any record was added or transitioned, so the caller can avoid a
 * needless write.
 * @param {{ v:number, findings:Record<string,any> }} store
 * @param {any[]} scanned findings from the current review scan
 * @param {number} now
 */
export function reconcileFindings(store, scanned, now = Date.now()) {
  const next = { v: 1, findings: { ...(store.findings || {}) } };
  let changed = false;
  const seen = new Set();

  for (const f of scanned || []) {
    const id = f.findingId || findingId(f);
    seen.add(id);
    const prev = next.findings[id];
    if (!prev) {
      next.findings[id] = {
        findingId: id,
        state: "found",
        firstSeen: now,
        lastSeen: now,
        present: true,
        fixSession: null,
        commit: null,
        history: [{ at: now, from: null, to: "found", cause: "scan" }],
        ...metaOf(f),
      };
      changed = true;
      continue;
    }
    const rec = { ...prev, ...metaOf(f), lastSeen: now, present: true };
    // A resolved finding re-detected by a fresh scan reopens for re-verification.
    if (prev.state === "resolved") {
      rec.state = "reverify-required";
      appendHistory(rec, {
        at: now,
        from: "resolved",
        to: "reverify-required",
        cause: "re-detected by scan",
      });
      changed = true;
    }
    next.findings[id] = rec;
  }

  // A finding that DISAPPEARED from the scan: if it was confirmed or dispatched,
  // its source was evidently changed -> advance to "changed".
  for (const [id, rec] of Object.entries(next.findings)) {
    if (seen.has(id)) continue;
    if (rec.present !== false) {
      rec.present = false;
      if (rec.state === "confirmed" || rec.state === "fix-dispatched") {
        appendHistory(rec, {
          at: now,
          from: rec.state,
          to: "changed",
          cause: "no longer detected",
        });
        rec.state = "changed";
      }
      changed = true;
    }
  }
  return { store: next, changed };
}

/**
 * Apply an explicit lifecycle transition to one finding. Rejects an illegal
 * transition (returns { ok:false }). Records who/when + optional correlation.
 * @param {{ findings:Record<string,any> }} store
 * @param {string} id
 * @param {string} to
 * @param {{ actor?:string, reason?:string, fixSession?:string, commit?:string, now?:number }} [meta]
 */
export function transitionFinding(store, id, to, meta = {}) {
  const rec = store.findings?.[id];
  if (!rec) return { ok: false, error: `no such finding: ${id}` };
  if (!canTransition(rec.state, to))
    return {
      ok: false,
      error: `illegal transition ${rec.state} -> ${to}`,
      from: rec.state,
    };
  const now = meta.now ?? Date.now();
  const from = rec.state;
  rec.state = to;
  if (meta.fixSession) rec.fixSession = meta.fixSession;
  if (meta.commit) rec.commit = meta.commit;
  if (to === "rejected" && meta.reason)
    rec.rejectReason = String(meta.reason).slice(0, 200);
  appendHistory(rec, {
    at: now,
    from,
    to,
    cause: meta.reason
      ? `${meta.actor || "panel"}: ${meta.reason}`
      : meta.actor || "panel",
  });
  rec.updatedAt = now;
  return { ok: true, finding: rec };
}

// Post-fix lifecycle states that are no longer in the scan but still need the
// operator to finish verification (so the resolve path is reachable in the UI).
const AWAITING_VERIFY_STATES = new Set([
  "fix-dispatched",
  "changed",
  "targeted-test-passed",
  "reverify-required",
]);

/**
 * Store-only findings the operator must still act on: records absent from the
 * current scan (present:false) whose lifecycle is non-terminal and post-fix.
 * Reconstructs a finding-shaped object from the persisted metadata so the Fix
 * Station can drive changed -> targeted-test-passed -> resolved. Excludes
 * scanned ids (decorateFindings already covers those) and terminal states.
 * @param {{ findings:Record<string,any> }} store
 * @param {any[]} scanned findings from the current scan (to exclude by id)
 */
export function activeStoreFindings(store, scanned) {
  const scannedIds = new Set(
    (scanned || []).map((f) => f.findingId || findingId(f)),
  );
  const out = [];
  for (const rec of Object.values(store?.findings || {})) {
    if (rec.present !== false) continue;
    if (scannedIds.has(rec.findingId)) continue;
    if (!AWAITING_VERIFY_STATES.has(rec.state)) continue;
    out.push({
      findingId: rec.findingId,
      file: rec.file || null,
      line: rec.line ?? null,
      ruleId: rec.ruleId || null,
      severity: rec.severity || "warn",
      title: rec.title || "",
      lifecycle: {
        state: rec.state,
        present: false,
        fixSession: rec.fixSession || null,
        commit: rec.commit || null,
        firstSeen: rec.firstSeen || null,
        rejectReason: rec.rejectReason || null,
      },
    });
  }
  return out;
}

/** Merge lifecycle state onto the scanned findings for the snapshot view. */
export function decorateFindings(scanned, store) {
  return (scanned || []).map((f) => {
    const id = f.findingId || findingId(f);
    const rec = store.findings?.[id];
    return {
      ...f,
      findingId: id,
      lifecycle: rec
        ? {
            state: rec.state,
            present: rec.present !== false,
            fixSession: rec.fixSession || null,
            commit: rec.commit || null,
            firstSeen: rec.firstSeen || null,
            rejectReason: rec.rejectReason || null,
          }
        : { state: "found", present: true },
    };
  });
}
