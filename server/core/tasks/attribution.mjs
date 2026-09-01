// @ts-check
/**
 * Which local work, if any, a CI failure can be pinned on.
 *
 * The default answer is "no reliable attribution", and it stays the default
 * until three independent things line up: a task bound by an observed marker
 * (not a time window), file paths the failing job actually named, and an
 * overlap between those paths and what the task changed. A plausible story is
 * not attribution - blaming the wrong change costs more time than saying
 * nothing, because the engineer then debugs the wrong file.
 */

const PATH_RE = /[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z]{1,5}/g;
const MAX_PATHS = 40;

/**
 * File paths a job's output actually names.
 *
 * Windows separators and `file://` URLs are normalized first, and a drive
 * letter falls away with them, so `D:/a/repo/tests/x.test.mjs` and
 * `tests\x.test.mjs` both reduce to the same repo-relative tail.
 */
export function pathsFromLog(text) {
  const normalized = String(text ?? "")
    .replace(/\\/g, "/")
    .replace(/file:\/\/+/g, "");
  const out = new Set();
  for (const m of normalized.matchAll(PATH_RE)) {
    const p = m[0].replace(/^\.\//, "");
    // Runner, toolchain and dependency paths say nothing about this branch:
    // a stack trace naming pwsh.EXE is not evidence about anyone's change.
    if (/(?:^|\/)(?:home|usr|opt)\//i.test(p)) continue;
    if (/(?:^|\/)Program Files/i.test(p)) continue;
    if (/\.(?:exe|dll|cmd|bat|msi|sys|so|dylib)$/i.test(p)) continue;
    if (p.includes("node_modules/")) continue;
    out.add(p);
    if (out.size >= MAX_PATHS) break;
  }
  return [...out];
}

/** True when two paths name the same file, allowing for a repo-root prefix. */
function samePath(a, b) {
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * @param {{name:string, jobId?:string|number|null}} failure
 * @param {{logText?:string|null, tasks?:object[]}} evidence
 * @returns {{attributed:boolean, reason:string, taskId?:string,
 *            sharedFiles?:string[], certainty?:"likely"}}
 */
export function attributeFailure(failure, evidence = {}) {
  const named = pathsFromLog(evidence.logText);
  if (!named.length)
    return {
      attributed: false,
      reason:
        "No reliable attribution: the job output named no file in this repo.",
      namedFiles: [],
    };

  const candidates = [];
  for (const task of evidence.tasks || []) {
    // A task the panel could not bind to a session by marker is not evidence of
    // anything: the session it "looks like" may belong to someone else's work.
    if (task.reconciliation !== "bound") continue;
    const files = task.evidence?.files || [];
    const shared = files.filter((f) => named.some((n) => samePath(n, f)));
    if (shared.length) candidates.push({ task, shared });
  }

  if (!candidates.length)
    return {
      attributed: false,
      reason:
        "No reliable attribution: no marker-bound task changed a file this job named.",
      namedFiles: named,
    };
  if (candidates.length > 1)
    return {
      attributed: false,
      reason: `No reliable attribution: ${candidates.length} tasks changed files this job named.`,
      namedFiles: named,
      candidates: candidates.map((c) => c.task.id),
    };

  const [only] = candidates;
  return {
    attributed: true,
    // Still an inference: the overlap is real, the causation is not proven.
    certainty: "likely",
    reason: `One marker-bound task changed ${only.shared.length} file(s) this job named.`,
    taskId: only.task.id,
    sharedFiles: only.shared,
    namedFiles: named,
  };
}
