// @ts-check
/**
 * Panel-owned, single-writer canonical event store. It ingests from two sources
 * — the live POST and a promotion pass over the hook-owned spool — and dedups by
 * event id, so an event delivered both ways is stored exactly once. Single-writer
 * ownership keeps the canonical log free of the concurrent-writer problem that
 * the multi-writer spool is allowed to have. NDJSON on disk: zero-dependency,
 * crash-safe, replayable. The in-memory session projection is rebuilt from the
 * store on construction.
 */
import fs from "node:fs";
import path from "node:path";
import { validateEvent } from "./schema.mjs";
import { applyEvent, reconcile as reconcileSessions } from "./projection.mjs";

const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

export class EventStore {
  /** @param {string} eventsDir <root>/.claude/.runtime/events */
  constructor(eventsDir) {
    this.dir = eventsDir;
    this.spoolDir = path.join(eventsDir, "spool");
    this.storeDir = path.join(eventsDir, "store");
    this.offsetsFile = path.join(this.storeDir, ".offsets.json");
    /** @type {Set<string>} */
    this.seen = new Set();
    /** @type {Map<string, any>} */
    this.sessions = new Map();
    this.offsets = this._loadOffsets();
    this._loadStore();
  }

  /**
   * Ingest one event (live POST or promotion). Idempotent by id; single-writer.
   * @param {any} evt
   */
  ingest(evt) {
    const err = validateEvent(evt, { now: Date.now() });
    if (err) return { ok: false, error: err };
    if (this.seen.has(evt.id)) return { ok: true, duplicate: true };
    this._append(evt);
    this.seen.add(evt.id);
    applyEvent(this.sessions, evt);
    return { ok: true };
  }

  /** Promote un-promoted spool lines into the canonical store. Returns the count. */
  promoteSpool() {
    return this.promoteSpoolFrom(this.spoolDir, "");
  }

  /**
   * Promote a spool DIRECTORY (the canonical one, or a legacy per-checkout one
   * during migration) into the store. Offsets are tracked per (prefix, file).
   * @param {string} spoolDir @param {string} keyPrefix
   */
  promoteSpoolFrom(spoolDir, keyPrefix) {
    let promoted = 0;
    let files;
    try {
      files = fs.readdirSync(spoolDir).filter((f) => f.endsWith(".ndjson"));
    } catch {
      return 0;
    }
    for (const f of files.sort()) {
      const key = `${keyPrefix}${f}`;
      const full = path.join(spoolDir, f);
      let size;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      const from = this.offsets[key] || 0;
      if (size <= from) continue;
      let buf;
      try {
        buf = fs.readFileSync(full);
      } catch {
        continue;
      }
      const chunk = buf.subarray(from, size);
      // Only consume up to the last COMPLETE record: a torn trailing line (no
      // newline yet) stays before the offset and is retried when a later
      // append completes it. A malformed line WITH a newline is complete and
      // skipped permanently.
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl === -1) continue;
      const completeBytes = lastNl + 1;
      for (const line of chunk
        .subarray(0, completeBytes)
        .toString("utf8")
        .split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let evt;
        try {
          evt = JSON.parse(t);
        } catch {
          continue; // malformed complete line: never valid, never retried
        }
        const r = this.ingest(evt);
        if (r.ok && !r.duplicate) promoted++;
      }
      this.offsets[key] = from + completeBytes;
    }
    this._saveOffsets();
    return promoted;
  }

  /** @param {number} [now] */
  reconcile(now = Date.now()) {
    reconcileSessions(this.sessions, now);
    return this;
  }

  snapshot() {
    return { sessions: [...this.sessions.values()], count: this.sessions.size };
  }

  /**
   * Delete store + spool day-files older than `days`, then rebuild the
   * in-memory dedup set and session projection from the SURVIVING store files.
   * Without the rebuild, `seen` and `sessions` grow unbounded over a long-lived
   * process (disk was reclaimed but memory was not), and a resurrected
   * same-named spool file could re-ingest ids no longer in the store.
   */
  rotate(days = 14, now = Date.now()) {
    const cutoff = dayOf(now - days * 86400000);
    for (const dir of [this.storeDir, this.spoolDir]) {
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(f);
        if (m && m[1] < cutoff) {
          try {
            fs.rmSync(path.join(dir, f), { force: true });
            delete this.offsets[f];
            // Do NOT clear the `legacy:<f>` offset here: the legacy spool lives
            // in a different (per-checkout) dir this loop does not delete, so
            // clearing its offset would re-ingest that surviving file from 0.
          } catch {
            /* ignore */
          }
        }
      }
    }
    // Rebuild seen + sessions from the surviving store so memory tracks the
    // on-disk retention window, not the whole process-lifetime volume.
    this.seen = new Set();
    this.sessions = new Map();
    this._loadStore();
    this._saveOffsets();
  }

  _append(evt) {
    fs.mkdirSync(this.storeDir, { recursive: true });
    const file = path.join(this.storeDir, `${dayOf(evt.ts)}.ndjson`);
    // SELF-FRAMING: unconditionally lead with a newline (no pre-append read).
    // The store is single-writer under the lock, but a lease-lock reclaim leaves
    // a bounded window where two panels can append; a stat-then-append heal is a
    // cross-process TOCTOU there. A leading "\n" on every record isolates a torn
    // predecessor with no read, so a transient double-writer can at worst produce
    // a skipped blank / a deduped duplicate, never a glued loss.
    fs.appendFileSync(file, "\n" + JSON.stringify(evt) + "\n");
  }

  _loadStore() {
    let files;
    try {
      files = fs.readdirSync(this.storeDir).filter((f) => /\.ndjson$/.test(f));
    } catch {
      return;
    }
    for (const f of files.sort()) {
      let buf;
      try {
        buf = fs.readFileSync(path.join(this.storeDir, f), "utf8");
      } catch {
        continue;
      }
      for (const line of buf.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let evt;
        try {
          evt = JSON.parse(t);
        } catch {
          continue;
        }
        if (evt?.id && !this.seen.has(evt.id)) {
          this.seen.add(evt.id);
          applyEvent(this.sessions, evt);
        }
      }
    }
  }

  _loadOffsets() {
    try {
      return JSON.parse(fs.readFileSync(this.offsetsFile, "utf8"));
    } catch {
      return {};
    }
  }

  _saveOffsets() {
    try {
      fs.mkdirSync(this.storeDir, { recursive: true });
      fs.writeFileSync(this.offsetsFile, JSON.stringify(this.offsets));
    } catch {
      /* offsets are an optimization; id-dedup remains correct without them */
    }
  }
}
