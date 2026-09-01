// @ts-check
/**
 * What git can say about a review's anchor: is the anchor still part of this
 * history, does the file still exist, did it change, and where did the reviewed
 * line end up.
 *
 * Two rules run through everything here. Exit status is data, so every command
 * whose answer is its exit code goes through `gitResult()` - "no" and "could
 * not tell" are different answers. And remote-supplied paths are arguments,
 * never syntax: each one is validated and only ever appears after `--`.
 */
import { gitResult } from "../../lib/git.mjs";
import { isSafeRelativeFile } from "../../lib/validate.mjs";
import { mapAnchorLine } from "./line-map.mjs";

/** Per-poll cap on line-level probes; beyond it the answer is unknown. */
export const LINE_PROBE_MAX = 40;

// Commit lines are prefixed with a NUL by the log format, so a file whose name
// happens to look like a sha is never mistaken for a commit header.
const NUL = "\u0000";

/**
 * Is `sha` an ancestor of HEAD? A rebase or force-push makes the anchor
 * unreachable, and then nothing derived from `<sha>..HEAD` means anything.
 * @returns {Promise<{value: boolean|null, reason: string}>}
 */
export async function anchorIsAncestor(sha, cwd, deps = {}) {
  const run = deps.gitResult || gitResult;
  if (!sha) return { value: null, reason: "the review has no anchor commit" };
  const r = await run(["merge-base", "--is-ancestor", sha, "HEAD"], cwd);
  if (r.code === 0)
    return { value: true, reason: "the review anchor is an ancestor of HEAD" };
  if (r.code === 1)
    return {
      value: false,
      reason: "the review anchor is not an ancestor of local HEAD",
    };
  return { value: null, reason: "git could not compare the review anchor" };
}

/**
 * Files touched between an anchor and HEAD. One call per DISTINCT anchor, not
 * per thread.
 * @returns {Promise<{files: Set<string>|null, reason: string}>}
 */
export async function filesTouchedSince(sha, cwd, deps = {}) {
  const run = deps.gitResult || gitResult;
  // `%x00` is expanded by git; a real NUL cannot be passed as a spawn argument.
  const r = await run(
    ["log", "--format=%x00%H", "--name-only", `${sha}..HEAD`],
    cwd,
  );
  if (!r.ok)
    return {
      files: null,
      reason: "git could not list commits since the review",
    };
  const files = new Set();
  for (const line of r.stdout.split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith(NUL)) continue;
    files.add(text);
  }
  return { files, reason: `${files.size} file(s) changed since the review` };
}

/**
 * Does the file still exist at HEAD? `git()` would report "absent" and "git
 * failed" identically, so this reads the exit code as well as the output.
 * @returns {Promise<{value: boolean|null, reason: string}>}
 */
export async function fileExistsAtHead(file, cwd, deps = {}) {
  const run = deps.gitResult || gitResult;
  if (!isSafeRelativeFile(file))
    return { value: null, reason: "the reviewed path is not a safe repo path" };
  const r = await run(["ls-tree", "--name-only", "HEAD", "--", file], cwd);
  if (!r.ok) return { value: null, reason: "git could not read the tree" };
  if (r.stdout.trim())
    return { value: true, reason: "the file exists at HEAD" };
  return { value: false, reason: "the file no longer exists at HEAD" };
}

/**
 * Where the reviewed line is now. Mapping comes first; blame is only ever run
 * against a mapped line, never against the raw anchor number.
 * @returns {Promise<{mapping: object, blameSha: string|null}>}
 */
export async function locateAnchorLine(anchor, cwd, deps = {}) {
  const run = deps.gitResult || gitResult;
  const { file, line, anchorCommitSha } = anchor || {};
  if (!isSafeRelativeFile(file))
    return {
      mapping: {
        kind: "unmappable",
        currentLine: null,
        offset: null,
        reasons: ["the reviewed path is not a safe repo path"],
      },
      blameSha: null,
    };

  const diff = await run(
    ["diff", "--unified=0", `${anchorCommitSha}..HEAD`, "--", file],
    cwd,
  );
  const mapping = mapAnchorLine(diff.stdout, line, { ok: diff.ok });
  if (mapping.kind !== "unchanged-mapped" || deps.skipBlame)
    return { mapping, blameSha: null };

  const blame = await run(
    [
      "blame",
      "-L",
      `${mapping.currentLine},${mapping.currentLine}`,
      "--porcelain",
      "HEAD",
      "--",
      file,
    ],
    cwd,
  );
  const sha = blame.ok ? /^([0-9a-f]{7,40})\s/.exec(blame.stdout)?.[1] : null;
  return { mapping, blameSha: sha ?? null };
}

/**
 * Collect the git side of the picture for a batch of threads. Anchors are
 * grouped so each distinct anchor costs one log call, and line probes are
 * capped - past the cap the line-level answer is `unknown`, never assumed.
 *
 * @param {string} cwd
 * @param {Array<{id:string, location:{file:string,line:number,anchorCommitSha:string}|null}>} threads
 * @param {{gitResult?:Function, dirtyFiles?:Set<string>, lineProbeMax?:number}} [deps]
 */
export async function collectGitFacts(cwd, threads, deps = {}) {
  const lineProbeMax = deps.lineProbeMax ?? LINE_PROBE_MAX;
  const dirty = deps.dirtyFiles || new Set();
  const byAnchor = new Map();
  for (const t of threads) {
    const sha = t.location?.anchorCommitSha;
    if (!sha) continue;
    if (!byAnchor.has(sha)) byAnchor.set(sha, []);
    byAnchor.get(sha).push(t);
  }

  /** @type {Map<string, {ancestor: object, touched: object}>} */
  const anchors = new Map();
  for (const sha of byAnchor.keys()) {
    const ancestor = await anchorIsAncestor(sha, cwd, deps);
    // A non-ancestor anchor makes `<sha>..HEAD` meaningless, so nothing is
    // derived from it: unknown beats a confident wrong answer.
    const touched =
      ancestor.value === true
        ? await filesTouchedSince(sha, cwd, deps)
        : { files: null, reason: ancestor.reason };
    anchors.set(sha, { ancestor, touched });
  }

  const facts = new Map();
  let probes = 0;
  for (const t of threads) {
    const loc = t.location;
    if (!loc?.file || !loc?.anchorCommitSha) {
      facts.set(t.id, {
        anchorValid: null,
        fileExists: null,
        fileChanged: null,
        dirty: false,
        mapping: null,
        blameSha: null,
        reasons: ["the review has no code anchor"],
        unknowns: ["anchor"],
      });
      continue;
    }

    const { ancestor, touched } = anchors.get(loc.anchorCommitSha);
    const exists = await fileExistsAtHead(loc.file, cwd, deps);
    const reasons = [ancestor.reason, exists.reason];
    const unknowns = [];
    if (ancestor.value !== true) unknowns.push("anchor");
    if (exists.value === null) unknowns.push("file");

    let fileChanged = null;
    if (touched.files) {
      fileChanged = touched.files.has(loc.file);
      reasons.push(
        fileChanged
          ? "the reviewed file changed since the review"
          : "the reviewed file has not changed since the review",
      );
    } else {
      unknowns.push("file-changed");
    }

    let mapping = null;
    let blameSha = null;
    if (ancestor.value === true && exists.value === true) {
      if (probes < lineProbeMax) {
        probes++;
        const located = await locateAnchorLine(loc, cwd, deps);
        mapping = located.mapping;
        blameSha = located.blameSha;
        reasons.push(...mapping.reasons);
        if (mapping.kind === "unknown" || mapping.kind === "unmappable")
          unknowns.push("line-level");
      } else {
        unknowns.push("line-level");
        reasons.push("line-level detail was skipped past the per-poll cap");
      }
    } else {
      unknowns.push("line-level");
    }

    facts.set(t.id, {
      anchorValid: ancestor.value,
      fileExists: exists.value,
      fileChanged,
      dirty: dirty.has(loc.file),
      mapping,
      blameSha,
      reasons,
      unknowns: [...new Set(unknowns)],
    });
  }
  return facts;
}
