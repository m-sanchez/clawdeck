// @ts-check
/**
 * Human promotions into the Attention Inbox.
 *
 * Only this file writes attention items, and it only ever writes what a person
 * clicked. An advisory suggestion that was promoted keeps a pointer to where it
 * came from, but the record's authority is the human's: the model can propose,
 * and only a person can put something in front of another person.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const PROMOTION_CAP = 100;
const ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;

export function attentionDir(runtimeDir) {
  return join(runtimeDir, "attention");
}
export function statePath(runtimeDir) {
  return join(attentionDir(runtimeDir), "promotions.json");
}

/** Never throws: an unreadable store degrades to an empty one. */
export function readPromotions(runtimeDir) {
  try {
    const raw = JSON.parse(readFileSync(statePath(runtimeDir), "utf8"));
    return Array.isArray(raw?.items) ? raw.items : [];
  } catch {
    return [];
  }
}

export function writePromotions(runtimeDir, items) {
  const dir = attentionDir(runtimeDir);
  const file = statePath(runtimeDir);
  const payload = JSON.stringify(
    { version: 1, items: items.slice(-PROMOTION_CAP) },
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
 * Record one promotion. Returns the stored item, or null when the input is not
 * something a person could have meant.
 *
 * @param {string} runtimeDir
 * @param {{id:string, title:string, kind?:string, detail?:string, link?:string,
 *          severity?:string, origin?:string}} input
 * @param {{now?:number}} [opts]
 */
export function promote(runtimeDir, input, opts = {}) {
  const now = new Date(opts.now ?? Date.now()).toISOString();
  const id = String(input?.id ?? "");
  const title = String(input?.title ?? "").slice(0, 200);
  if (!ID_RE.test(id) || !title) return null;

  const items = readPromotions(runtimeDir).filter((i) => i.id !== id);
  const record = {
    id,
    title,
    kind: input.kind ?? "promoted",
    detail: input.detail ? String(input.detail).slice(0, 500) : null,
    link: input.link ?? null,
    severity:
      input.severity === "blocking"
        ? "attention"
        : (input.severity ?? "attention"),
    // Where the text came from, kept as provenance and never as authority.
    origin: input.origin ? String(input.origin).slice(0, 200) : null,
    addedAt: now,
  };
  items.push(record);
  writePromotions(runtimeDir, items);
  return record;
}

/** Remove one promotion; returns true when something was actually removed. */
export function dismiss(runtimeDir, id) {
  const items = readPromotions(runtimeDir);
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) return false;
  writePromotions(runtimeDir, next);
  return true;
}
