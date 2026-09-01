// @ts-check
/**
 * Durable local marks for review threads: what the human did, never what was
 * derived.
 *
 * Derived state is deliberately not persisted. Remote resolution and git facts
 * move underneath us, and a "resolved" served from disk after the provider
 * reopened a thread is exactly the lie this feature exists to avoid. Marks are
 * cheap to store; derivation is cheap to redo.
 *
 * Drafts live in their own files, so a reply body never rides in the state
 * document and never reaches the snapshot.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const THREAD_CAP = 500;
export const HISTORY_CAP = 40;
export const ASSIST_CAP = 10;
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const ID_RE = /^rt_[0-9a-f]{24}$/;

export function inboxDir(runtimeDir) {
  return join(runtimeDir, "review-inbox");
}
export function statePath(runtimeDir) {
  return join(inboxDir(runtimeDir), "state.json");
}
export function draftsDir(runtimeDir) {
  return join(inboxDir(runtimeDir), "drafts");
}

/** Never throws: an unreadable store degrades to an empty one. */
export function readInboxStore(runtimeDir) {
  try {
    const raw = JSON.parse(readFileSync(statePath(runtimeDir), "utf8"));
    return {
      version: 1,
      threads:
        raw?.threads && typeof raw.threads === "object" ? raw.threads : {},
      capabilities: raw?.capabilities ?? null,
    };
  } catch {
    return { version: 1, threads: {}, capabilities: null };
  }
}

/** tmp + rename, with the direct-write fallback the other stores use on Windows. */
export function writeInboxStore(runtimeDir, store) {
  const dir = inboxDir(runtimeDir);
  const file = statePath(runtimeDir);
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    try {
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, JSON.stringify(store, null, 2));
      rmSync(tmp, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}

function record(now) {
  return {
    firstSeen: now,
    lastSeen: now,
    present: true,
    mark: "none",
    markAt: null,
    lastReadAt: null,
    draft: null,
    assists: [],
    history: [],
  };
}

/**
 * Fold the freshly fetched threads into the store: seen ones stay, missing ones
 * are marked absent rather than deleted (a thread can vanish from a page and
 * come back, and the human's mark should survive that).
 */
export function reconcileThreads(store, threads, now = Date.now()) {
  const next = { ...store, threads: { ...store.threads } };
  const seen = new Set();
  let changed = false;

  for (const t of threads) {
    if (!ID_RE.test(t.id)) continue;
    seen.add(t.id);
    const prev = next.threads[t.id];
    if (!prev) {
      next.threads[t.id] = record(now);
      changed = true;
    } else if (prev.present !== true || prev.lastSeen !== now) {
      next.threads[t.id] = { ...prev, present: true, lastSeen: now };
      changed = true;
    }
  }
  for (const [id, rec] of Object.entries(next.threads)) {
    if (!seen.has(id) && rec.present !== false) {
      next.threads[id] = { ...rec, present: false };
      changed = true;
    }
  }

  const ids = Object.keys(next.threads);
  if (ids.length > THREAD_CAP) {
    const keep = ids
      .sort(
        (a, b) =>
          (next.threads[b].lastSeen || 0) - (next.threads[a].lastSeen || 0),
      )
      .slice(0, THREAD_CAP);
    const trimmed = {};
    for (const id of keep) trimmed[id] = next.threads[id];
    next.threads = trimmed;
    changed = true;
  }
  return { store: next, changed };
}

const MARKS = new Set([
  "none",
  "acknowledged",
  "investigating",
  "needs-human",
  "wont-fix",
]);

/** Record an explicit human mark. Model output can never reach this. */
export function markThread(store, id, mark, now = Date.now()) {
  if (!ID_RE.test(id)) return { ok: false, error: "Unknown thread id." };
  if (!MARKS.has(mark)) return { ok: false, error: `Unknown mark: ${mark}` };
  const prev = store.threads[id] || record(now);
  const at = new Date(now).toISOString();
  const updated = {
    ...prev,
    mark,
    markAt: at,
    history: [...(prev.history || []), { at, from: prev.mark, to: mark }].slice(
      -HISTORY_CAP,
    ),
  };
  return {
    ok: true,
    store: { ...store, threads: { ...store.threads, [id]: updated } },
    record: updated,
  };
}

/** Remember that the human has seen the thread as of `updatedAt`. */
export function touchRead(store, id, now = Date.now()) {
  if (!ID_RE.test(id)) return { ok: false, error: "Unknown thread id." };
  const prev = store.threads[id] || record(now);
  const updated = { ...prev, lastReadAt: now };
  return {
    ok: true,
    store: { ...store, threads: { ...store.threads, [id]: updated } },
    record: updated,
  };
}

/**
 * An audit stub for one assist: what kind, when, whether it succeeded. The
 * model's text is never stored - it is advisory output, not a record.
 */
export function recordAssist(
  store,
  id,
  { kind, ok, elapsedMs },
  now = Date.now(),
) {
  if (!ID_RE.test(id)) return { ok: false, error: "Unknown thread id." };
  const prev = store.threads[id] || record(now);
  const stub = {
    kind,
    ok: Boolean(ok),
    elapsedMs: Number(elapsedMs) || 0,
    at: new Date(now).toISOString(),
  };
  const updated = {
    ...prev,
    assists: [...(prev.assists || []), stub].slice(-ASSIST_CAP),
  };
  return {
    ok: true,
    store: { ...store, threads: { ...store.threads, [id]: updated } },
    record: updated,
  };
}

export function readDraft(runtimeDir, id) {
  if (!ID_RE.test(id)) return null;
  try {
    const body = readFileSync(join(draftsDir(runtimeDir), `${id}.md`), "utf8");
    return { body, chars: body.length };
  } catch {
    return null;
  }
}

/** Saving a draft is a human action; it is what makes a thread REPLY_DRAFTED. */
export function writeDraft(runtimeDir, id, body) {
  if (!ID_RE.test(id)) return { ok: false, error: "Unknown thread id." };
  try {
    mkdirSync(draftsDir(runtimeDir), { recursive: true });
    writeFileSync(join(draftsDir(runtimeDir), `${id}.md`), String(body ?? ""));
    return { ok: true, chars: String(body ?? "").length };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

export function clearDraft(runtimeDir, id) {
  if (!ID_RE.test(id)) return { ok: false, error: "Unknown thread id." };
  rmSync(join(draftsDir(runtimeDir), `${id}.md`), { force: true });
  return { ok: true };
}

/** Drop long-absent threads nobody marked or drafted against. */
export function pruneInbox(store, now = Date.now(), maxAgeMs = PRUNE_AFTER_MS) {
  const threads = {};
  let changed = false;
  for (const [id, rec] of Object.entries(store.threads)) {
    const stale = rec.present === false && now - (rec.lastSeen || 0) > maxAgeMs;
    const untouched = rec.mark === "none" && !rec.draft;
    if (stale && untouched) {
      changed = true;
      continue;
    }
    threads[id] = rec;
  }
  return { store: changed ? { ...store, threads } : store, changed };
}

/** Draft metadata for the derivation, without reading bodies into the snapshot. */
export function draftIndex(runtimeDir) {
  const index = new Map();
  try {
    for (const name of readdirSync(draftsDir(runtimeDir))) {
      if (!name.endsWith(".md")) continue;
      const id = name.slice(0, -3);
      if (!ID_RE.test(id)) continue;
      const draft = readDraft(runtimeDir, id);
      if (draft) index.set(id, { chars: draft.chars });
    }
  } catch {
    /* no drafts yet */
  }
  return index;
}

/** True when the store directory exists; used only for diagnostics. */
export function storeExists(runtimeDir) {
  return existsSync(statePath(runtimeDir));
}
