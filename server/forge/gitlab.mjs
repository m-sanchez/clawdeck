// @ts-check
/**
 * Read-only GitLab connector. Reads the branch's open MR and latest pipeline
 * via the GitLab REST API and maps them to the normalized forge shape. GET
 * requests only, to the detected host and project.
 */

async function get(apiBase, path, token, signal) {
  const headers = {};
  if (token) headers["PRIVATE-TOKEN"] = token;
  const res = await fetch(`${apiBase}${path}`, { headers, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** The web URL to open a new MR for a branch (no API call). */
export function gitlabNewMrUrl(forge, branch, target) {
  const p = new URLSearchParams({
    "merge_request[source_branch]": branch || "",
    "merge_request[target_branch]": target,
  });
  return `${forge.webBase}/${forge.project}/-/merge_requests/new?${p.toString()}`;
}

/**
 * Open MR for `branch` (if any) plus the branch's latest pipeline. Read-only.
 * Returns the normalized forge status shape.
 */
export async function gitlabStatus(forge, token, branch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const project = encodeURIComponent(forge.project);
  const enc = encodeURIComponent(branch);
  try {
    // Latest MRs across ALL states (ordered by update) so a merged/closed MR is
    // visible — an opened-only query cannot see it, which would leave the
    // delivery "Merged" stage permanently pending.
    const [mrs, pipes] = await Promise.all([
      get(
        forge.apiBase,
        `/projects/${project}/merge_requests?source_branch=${enc}&order_by=updated_at&sort=desc&per_page=5`,
        token,
        ctrl.signal,
      ),
      get(
        forge.apiBase,
        `/projects/${project}/pipelines?ref=${enc}&per_page=1`,
        token,
        ctrl.signal,
      ),
    ]);
    const list = Array.isArray(mrs) ? mrs : [];
    const mr = list.find((m) => m.state === "opened") || list[0] || null;
    const merged = list.some((m) => m.state === "merged");
    const pipeline = Array.isArray(pipes) ? pipes[0] : null;
    return {
      configured: true,
      provider: "gitlab",
      branch,
      fetchedAt: new Date().toISOString(),
      merged,
      mr: mr
        ? {
            iid: mr.iid,
      headSha: mr.sha ?? null,
            title: mr.title,
            state: mr.state,
            draft: Boolean(mr.draft || mr.work_in_progress),
            hasConflicts: Boolean(mr.has_conflicts),
            notes: mr.user_notes_count ?? 0,
            target: mr.target_branch,
            webUrl: mr.web_url,
            updatedAt: mr.updated_at,
            mergedAt: mr.merged_at ?? null,
          }
        : null,
      pipeline: pipeline
        ? {
            id: pipeline.id,
            status: pipeline.status,
            sha: String(pipeline.sha || "").slice(0, 9),
            webUrl: pipeline.web_url,
            updatedAt: pipeline.updated_at,
          }
        : null,
    };
  } catch (e) {
    const aborted = e && /** @type {any} */ (e).name === "AbortError";
    return {
      configured: true,
      provider: "gitlab",
      branch,
      error: aborted ? "timed out" : String((e && e.message) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}
