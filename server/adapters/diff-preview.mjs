// @ts-check
/**
 * Read-only preview of what a review pack would contain: the files changed between
 * the review base and HEAD, with per-file +/- line counts. Base resolution:
 * the remote default branch (origin/HEAD) first, then common branch names,
 * finally HEAD~1. Never writes.
 */
import { git } from "../lib/git.mjs";

const BASE_REFS = [
  "origin/HEAD",
  "origin/main",
  "main",
  "origin/develop",
  "develop",
  "origin/master",
  "master",
];

export async function resolveBase(cwd) {
  for (const ref of BASE_REFS) {
    const mb = (await git(["merge-base", ref, "HEAD"], cwd))?.trim();
    if (mb) return { ref, base: mb };
  }
  const fallback =
    (await git(["rev-parse", "HEAD~1"], cwd))?.trim() ||
    (await git(["rev-parse", "HEAD"], cwd))?.trim() ||
    "";
  return { ref: "HEAD~1", base: fallback };
}

/**
 * @param {string} cwd
 * @returns {Promise<{ base: string, baseSha: string, totalFiles: number, totalAdded: number, totalRemoved: number, files: { path: string, added: number|null, removed: number|null }[] }>}
 */
export async function getDiffPreview(cwd) {
  const { ref, base } = await resolveBase(cwd);
  const empty = {
    base: ref,
    baseSha: "",
    totalFiles: 0,
    totalAdded: 0,
    totalRemoved: 0,
    files: [],
  };
  if (!base) return empty;
  const out = await git(["diff", "--numstat", `${base}...HEAD`], cwd);
  if (out == null) return { ...empty, baseSha: base.slice(0, 9) };
  const files = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const a = parts[0];
    const r = parts[1];
    const path = parts.slice(2).join("\t");
    const added = a === "-" ? null : Number(a);
    const removed = r === "-" ? null : Number(r);
    if (typeof added === "number" && Number.isFinite(added))
      totalAdded += added;
    if (typeof removed === "number" && Number.isFinite(removed))
      totalRemoved += removed;
    files.push({ path, added, removed });
  }
  files.sort(
    (x, y) =>
      (y.added || 0) + (y.removed || 0) - ((x.added || 0) + (x.removed || 0)),
  );
  return {
    base: ref,
    baseSha: base.slice(0, 9),
    totalFiles: files.length,
    totalAdded,
    totalRemoved,
    files: files.slice(0, 200),
  };
}
