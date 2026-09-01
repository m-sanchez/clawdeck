// @ts-check
/**
 * Whether the provider will merge this change, asked of the provider.
 *
 * Counting approvals is not a policy read. Two approvals mean nothing if the
 * rule requires three, requires a specific team, or requires the branch to be
 * up to date - and none of that is visible from the review list. So this module
 * asks the only party that knows, and reports `unknown` when the answer is not
 * available rather than inferring one.
 *
 * GitHub computes mergeability lazily: a fresh PR answers `mergeable: null`
 * while it works, which is genuinely unknown and must not be read as "no".
 *
 * Read-only: GETs only, no mutation document, no write path.
 */

const TIMEOUT_MS = 8000;

/** Normalized shape, so a caller never has to know which provider answered. */
function shape(over = {}) {
  return {
    ok: false,
    provider: null,
    mergeable: "unknown",
    hasConflicts: null,
    blockingDiscussionsResolved: null,
    /** Provider's own status string, kept verbatim for the Why? disclosure. */
    status: null,
    /** True when the provider says the branch must be updated before merging. */
    behindBlocks: null,
    reason: null,
    observedAt: null,
    ...over,
  };
}

/**
 * @param {{apiBase:string, project:string}} forge
 * @param {string|null} token
 * @param {number|string} iid
 * @param {{fetchImpl?:Function, now?:number}} [opts]
 */
export async function githubMergeability(forge, token, iid, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const observedAt = new Date(opts.now ?? Date.now()).toISOString();
  if (!iid) return shape({ observedAt, reason: "no open change" });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${forge.apiBase}/repos/${forge.project}/pulls/${iid}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: ctrl.signal,
      },
    );
    if (!res.ok)
      return shape({
        provider: "github",
        observedAt,
        reason: `HTTP ${res.status}`,
      });
    const pr = await res.json();
    const state = pr.mergeable_state ?? null;
    return shape({
      ok: true,
      provider: "github",
      observedAt,
      // null means "still computing", which is unknown, not unmergeable.
      mergeable: pr.mergeable == null ? "unknown" : Boolean(pr.mergeable),
      hasConflicts:
        state === "dirty" ? true : pr.mergeable === true ? false : null,
      status: state,
      // `behind` is the provider stating its own up-to-date-branch rule, which
      // is the one case where being behind is a known block rather than a guess.
      behindBlocks: state === "behind" ? true : state ? false : null,
      reason: state ? `mergeable_state = ${state}` : null,
    });
  } catch (error) {
    return shape({
      provider: "github",
      observedAt,
      reason: String(error?.message || error),
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{apiBase:string, project:string}} forge
 * @param {string|null} token
 * @param {number|string} iid
 * @param {{fetchImpl?:Function, now?:number}} [opts]
 */
export async function gitlabMergeability(forge, token, iid, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const observedAt = new Date(opts.now ?? Date.now()).toISOString();
  if (!iid) return shape({ observedAt, reason: "no open change" });
  if (!token)
    return shape({
      provider: "gitlab",
      observedAt,
      reason: "a GitLab token is required",
    });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${forge.apiBase}/projects/${encodeURIComponent(forge.project)}/merge_requests/${iid}`,
      { headers: { "PRIVATE-TOKEN": token }, signal: ctrl.signal },
    );
    if (!res.ok)
      return shape({
        provider: "gitlab",
        observedAt,
        reason: `HTTP ${res.status}`,
      });
    const mr = await res.json();
    const status = mr.detailed_merge_status ?? null;
    return shape({
      ok: true,
      provider: "gitlab",
      observedAt,
      mergeable: status === "mergeable" ? true : status ? false : "unknown",
      hasConflicts:
        status === "conflict"
          ? true
          : mr.has_conflicts === false
            ? false
            : null,
      // The project's own discussion rule, not a count of open threads.
      blockingDiscussionsResolved:
        typeof mr.blocking_discussions_resolved === "boolean"
          ? mr.blocking_discussions_resolved
          : null,
      status,
      behindBlocks: status === "need_rebase" ? true : status ? false : null,
      reason: status ? `detailed_merge_status = ${status}` : null,
    });
  } catch (error) {
    return shape({
      provider: "gitlab",
      observedAt,
      reason: String(error?.message || error),
    });
  } finally {
    clearTimeout(timer);
  }
}
