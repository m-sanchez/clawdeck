"use strict";
/**
 * Shared durable event spool used by every hook-side emitter (lifecycle
 * emitter, policy enforcement) and by the panel. The canonical control-plane
 * root is the MAIN checkout's runtime dir, resolved from any linked worktree
 * by pure .git-file parsing (no subprocess, so the fire-and-forget emitter
 * stays fast). Append-only NDJSON day files; the panel promotes them into its
 * single-writer store. CommonJS so CJS hooks can require it directly.
 */
const fs = require("node:fs");
const path = require("node:path");

function dateStr(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Resolve the MAIN checkout root for a possibly-linked worktree:
 *   - `.git` directory  -> already the main checkout
 *   - `.git` file       -> `gitdir: <path>` points into `<main>/.git/worktrees/<name>`;
 *                          prefer its `commondir` file, else the path shape.
 * Any unreadable/unexpected layout degrades to the given root (per-checkout
 * behavior, never a crash).
 * @param {string} checkoutRoot
 */
function sharedRuntimeRoot(checkoutRoot) {
  const root = String(checkoutRoot || "");
  try {
    const dotGit = path.join(root, ".git");
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return root;
    if (!st.isFile()) return root;
    const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
    if (!m) return root;
    const gitdir = path.resolve(root, m[1].trim());
    // commondir points (usually relatively) at the main `.git`.
    try {
      const common = fs
        .readFileSync(path.join(gitdir, "commondir"), "utf8")
        .trim();
      // A valid commondir points at the MAIN `.git` (an ANCESTOR of this
      // worktree's gitdir, e.g. "../.."). An empty/whitespace value, or one that
      // resolves back INTO gitdir (".", "./", or a deeper path), would split
      // events under <main>/.git/worktrees/... — fall through to the path-shape
      // parse instead of trusting it.
      if (common) {
        const commonGit = path.resolve(gitdir, common);
        const rel = path.relative(gitdir, commonGit);
        // A legitimate commondir is a PURE-UP path ("../.."). Require EVERY
        // segment to be ".." — an up-then-DOWN path ("../../elsewhere", or an
        // absolute commondir resolving to one) is not an ancestor and must fall
        // through, never relocate the control plane into an attacker-named dir.
        const ancestorOfGitdir =
          rel !== "" && rel.split(path.sep).every((s) => s === "..");
        if (ancestorOfGitdir) return path.dirname(commonGit);
      }
    } catch {
      /* fall through to the path-shape parse */
    }
    // <main>/.git/worktrees/<name> -> three levels up.
    const worktreesDir = path.dirname(gitdir);
    if (path.basename(worktreesDir) === "worktrees") {
      const mainGit = path.dirname(worktreesDir);
      if (path.basename(mainGit) === ".git") return path.dirname(mainGit);
    }
    return root;
  } catch {
    return root;
  }
}

/** Canonical shared events dir for any checkout of the repository. */
function sharedEventsDir(checkoutRoot) {
  return path.join(
    sharedRuntimeRoot(checkoutRoot),
    ".claude",
    ".runtime",
    "events",
  );
}

/** <root>/.claude/.runtime/events for a given checkout root (no sharing). */
function eventsDirFor(checkoutRoot) {
  return path.join(checkoutRoot, ".claude", ".runtime", "events");
}

/** Append one normalized event envelope to the day spool under eventsDir. */
function appendSpool(eventsDir, evt, ts) {
  const spoolDir = path.join(eventsDir, "spool");
  fs.mkdirSync(spoolDir, { recursive: true });
  const file = path.join(spoolDir, `${dateStr(ts)}.ndjson`);
  // SELF-FRAMING: unconditionally lead with a newline. The spool is multi-writer
  // (many concurrent hook emitters), so a pre-append read of the trailing byte
  // is a TOCTOU — a torn record written by a concurrently-killed emitter can
  // appear AFTER the read but before this append, gluing this record onto it and
  // losing it on promotion. A leading "\n" on EVERY record isolates a torn
  // predecessor regardless of interleaving, with no read at all. The one cost is
  // a blank line, which promoteSpoolFrom skips (each writeSync is one O_APPEND).
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, "\n" + JSON.stringify(evt) + "\n");
  } finally {
    fs.closeSync(fd);
  }
}

const INGEST_FILE = "ingest.json";
const LEGACY_TOKEN_FILE = "ingest.token";

/**
 * The canonical panel advertises how emitters reach it: bearer token + port.
 * Written next to the shared spool so every worktree emitter can find it.
 */
function writeIngestDescriptor(eventsDir, { token, port }) {
  fs.mkdirSync(eventsDir, { recursive: true });
  const file = path.join(eventsDir, INGEST_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ token, port }));
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, JSON.stringify({ token, port }));
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
  // Legacy sidecar so an older emitter still authenticates.
  try {
    fs.writeFileSync(path.join(eventsDir, LEGACY_TOKEN_FILE), String(token));
  } catch {
    /* best-effort */
  }
}

/** @returns {{token:string, port:number|null}} empty token when unreadable. */
function readIngestDescriptor(eventsDir) {
  try {
    const d = JSON.parse(
      fs.readFileSync(path.join(eventsDir, INGEST_FILE), "utf8"),
    );
    return {
      token: typeof d.token === "string" ? d.token : "",
      port: Number.isFinite(Number(d.port)) ? Number(d.port) : null,
    };
  } catch {
    /* fall through to the legacy plain-token file */
  }
  try {
    return {
      token: fs
        .readFileSync(path.join(eventsDir, LEGACY_TOKEN_FILE), "utf8")
        .trim(),
      port: null,
    };
  } catch {
    return { token: "", port: null };
  }
}

const LOCK_FILE = ".writer.lock";

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

/**
 * A parsed object is a valid lock ONLY if it satisfies the protocol domain: a
 * pid that is a safe integer greater than 0, and an `at` that is a safe integer
 * greater than or equal to 0. Anything else (null, a primitive, an array, a
 * missing/non-numeric/zero/negative/fractional pid or at) is malformed and
 * therefore stale, it must be reclaimed, never mistaken for a live owner.
 * Callers MUST validate shape before evaluating owner pid, liveness, or freshness.
 */
function isValidLock(o) {
  return (
    o != null &&
    typeof o === "object" &&
    typeof o.pid === "number" &&
    Number.isSafeInteger(o.pid) &&
    o.pid > 0 &&
    typeof o.at === "number" &&
    Number.isSafeInteger(o.at) &&
    o.at >= 0
  );
}

// A held lock is heartbeated (touchWriterLock) well within this window; a lock
// whose `at` is older is treated as stale even if its recorded pid is alive
// (guards pid reuse after a crash without release).
const LOCK_TTL_MS = 2 * 60 * 1000;

// Synchronous short backoff (no busy-spin) between atomic-rename retries.
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* Atomics unavailable: skip the backoff */
  }
}

function writeLockFile(file, pid, now) {
  // Atomic publish for a lock we already own (refresh/reclaim): write a temp
  // file then rename over the target, so a reader never sees a 0-byte lock.
  const tmp = `${file}.${pid}.${now}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid, at: now }));
  // Retry the rename on the transient Windows sharing errors that can hit a
  // rename-over-a-freshly-linked file, so a single hiccup does not fail the
  // publish (and, via touchWriterLock, wrongly demote the sole live writer).
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (!/^(EPERM|EACCES|EBUSY)$/.test((e && e.code) || "")) break;
      sleepMs(2);
    }
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
  throw lastErr;
}

/**
 * Atomically CREATE the lock with its full payload. Writes a fully-populated
 * temp file, then hard-links it into place — link fails if the target already
 * exists (EEXIST), so exactly one concurrent creator wins AND the lock is never
 * observable at 0 bytes (closing the open-then-write window where a concurrent
 * reader could see an empty lock and wrongly reclaim it → double-own). Used
 * only for the initial acquisition.
 */
function createLockFileExclusive(file, pid, now) {
  const tmp = `${file}.new.${pid}.${now}`;
  fs.writeFileSync(tmp, JSON.stringify({ pid, at: now }));
  try {
    fs.linkSync(tmp, file); // atomic exclusive publish; throws if file exists
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Single-canonical-writer lock over the shared store. Only the panel holding
 * it may promote the spool and append to the canonical store; a second panel
 * degrades to its local per-checkout view instead of corrupting the log. A
 * lock is reclaimed when its owner pid is dead OR its heartbeat `at` is older
 * than LOCK_TTL_MS (covers a crash whose pid was later reused).
 * @param {string} eventsDir
 * @param {number} pid
 * @param {{ isAlive?: (pid:number)=>boolean, now?: ()=>number, ttlMs?: number,
 *   beforeReclaim?: (file:string)=>void }} [opts] beforeReclaim is a test seam.
 */
function acquireWriterLock(eventsDir, pid, opts = {}) {
  const alive = opts.isAlive || pidAlive;
  const now = (opts.now || Date.now)();
  const ttl = opts.ttlMs || LOCK_TTL_MS;
  fs.mkdirSync(eventsDir, { recursive: true });
  const file = path.join(eventsDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    let owner = null;
    let exists = false;
    try {
      owner = JSON.parse(fs.readFileSync(file, "utf8"));
      exists = true;
    } catch {
      try {
        exists = fs.existsSync(file);
      } catch {
        exists = false;
      }
      // present but unreadable -> treat as stale below
    }
    if (!exists) {
      try {
        createLockFileExclusive(file, pid, now); // O_EXCL: one racer wins
        return { ok: true };
      } catch {
        continue; // lost a create race; re-read on the next attempt
      }
    }
    // Shape-validate BEFORE reading owner/liveness/freshness. A parseable but
    // malformed lock (missing/NaN pid or `at`) must never be mistaken for a live
    // owner: e.g. {pid:1,at:"soon"} where Number("soon")||0 = 0 looks "fresh"
    // under any clock and, with a live pid 1 (Linux init), would hold the lock
    // forever. Invalid shape falls through to the reclaim path below.
    const validOwner = isValidLock(owner);
    const ownerPid = validOwner ? owner.pid : undefined;
    if (ownerPid === pid) {
      writeLockFile(file, pid, now); // refresh our own heartbeat
      return { ok: true };
    }
    const fresh = validOwner && now - owner.at < ttl;
    if (validOwner && alive(ownerPid) && fresh) return { ok: false, ownerPid };
    // Dead owner, unreadable, or heartbeat expired -> reclaim. An unconditional
    // delete-then-create races a concurrent fresh acquirer into a double-own
    // (both callers get ok:true). Instead: re-read at the last moment and only
    // proceed if the lock is STILL the stale owner we decided on; then STEAL it
    // by rename (atomic — one racer wins, the loser gets ENOENT) before an
    // exclusive create. opts.beforeReclaim is a test seam to inject a racer.
    if (typeof opts.beforeReclaim === "function") opts.beforeReclaim(file);
    let current = null;
    let unreadable = false;
    try {
      current = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      if (!fs.existsSync(file)) {
        // Vanished under us -> try the exclusive create.
        try {
          createLockFileExclusive(file, pid, now);
          return { ok: true };
        } catch {
          continue;
        }
      }
      unreadable = true;
    }
    // Corrupt/0-byte OR parseable-but-not-a-valid-lock (null, a primitive, an
    // object missing a finite pid/at). A valid lock is published atomically, so
    // any of these is stale — steal it (we cannot compare an owner, but it IS
    // stale; the rename below still serializes racers). Same shape gate as the
    // initial read, so a malformed lock is handled identically on both paths.
    if (!unreadable && !isValidLock(current)) {
      unreadable = true;
    }
    if (
      !unreadable &&
      (current.pid !== ownerPid || Number(current.at) !== Number(owner?.at))
    ) {
      continue; // replaced under us -> re-loop and re-decide against the fresh lock
    }
    const stolen = `${file}.stale.${pid}.${now}`;
    try {
      fs.renameSync(file, stolen); // atomic steal; ENOENT if a racer took it
    } catch {
      continue;
    }
    try {
      fs.rmSync(stolen, { force: true });
    } catch {
      /* ignore */
    }
    try {
      createLockFileExclusive(file, pid, now);
      return { ok: true };
    } catch {
      continue; // a fresh creator beat us; re-read -> report their ownership
    }
  }
  return { ok: false, ownerPid: null };
}

// On a FAILED heartbeat publish, keep ownership ONLY while the last on-disk
// heartbeat is still fresh (a transient hiccup). Once it is old enough to be
// reclaimed, demote — otherwise a frozen writer would keep writing the shared
// store alongside a new owner that legitimately reclaimed the age-stale lock.
function retainOnFailedRefresh(cur, pid, now) {
  return (
    cur != null && cur.pid === pid && now - (Number(cur.at) || 0) < LOCK_TTL_MS
  );
}

/** Refresh the held lock's heartbeat so a live owner is never seen as stale. */
function touchWriterLock(eventsDir, pid, now = Date.now()) {
  const file = path.join(eventsDir, LOCK_FILE);
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    if (owner?.pid !== pid) return false;
  } catch {
    return false; // not ours / missing: do not adopt it
  }
  try {
    writeLockFile(file, pid, now);
  } catch {
    // The publish failed. Mask a TRANSIENT hiccup (heartbeat still fresh) so the
    // sole live writer is not demoted on a single Windows rename EPERM; but once
    // the last heartbeat is old enough to be reclaimed, demote — otherwise this
    // frozen writer would double-write with a new owner. Re-read to decide.
    let cur = null;
    try {
      cur = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return false;
    }
    if (!retainOnFailedRefresh(cur, pid, now)) return false;
  }
  return true;
}

function releaseWriterLock(eventsDir, pid) {
  const file = path.join(eventsDir, LOCK_FILE);
  // Only the owner may release; never force-delete a lock we cannot confirm is
  // ours (an unreadable/foreign lock is left for age-based reclaim).
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    if (owner?.pid !== pid) return false;
  } catch {
    return false;
  }
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  dateStr,
  eventsDirFor,
  sharedRuntimeRoot,
  sharedEventsDir,
  appendSpool,
  writeIngestDescriptor,
  readIngestDescriptor,
  acquireWriterLock,
  touchWriterLock,
  retainOnFailedRefresh,
  releaseWriterLock,
  isValidLock,
  LOCK_TTL_MS,
};
