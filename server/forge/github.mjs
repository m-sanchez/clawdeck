// @ts-check
/**
 * Read-only GitHub connector. Reads the branch's pull request and latest
 * Actions run via the REST API and maps them to the normalized forge shape
 * (PR → mr, workflow run → pipeline). GET requests only. A token is optional:
 * public repositories answer unauthenticated (rate-limited).
 */

async function get(apiBase, path, token, signal) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${apiBase}${path}`, { headers, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** The compare URL that opens a new PR for a branch (no API call). */
export function githubNewMrUrl(forge, branch, target) {
  return `${forge.webBase}/${forge.project}/compare/${encodeURIComponent(
    target,
  )}...${encodeURIComponent(branch || "")}?expand=1`;
}

/** GitLab-vocabulary pipeline status for a workflow run (single status word). */
function runStatus(run) {
  if (!run) return null;
  if (run.status === "completed") {
    const c = run.conclusion;
    if (c === "success") return "success";
    if (c === "cancelled") return "canceled";
    if (c === "skipped") return "skipped";
    return "failed";
  }
  if (run.status === "in_progress") return "running";
  return "pending";
}

/**
 * PR for `branch` (if any) plus the branch's latest workflow run. Read-only.
 * Returns the normalized forge status shape.
 */
export async function githubStatus(forge, token, branch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const owner = forge.project.split("/")[0];
  const enc = encodeURIComponent(branch);
  try {
    const [prs, runs] = await Promise.all([
      get(
        forge.apiBase,
        `/repos/${forge.project}/pulls?head=${encodeURIComponent(owner)}:${enc}&state=all&sort=updated&direction=desc&per_page=5`,
        token,
        ctrl.signal,
      ),
      get(
        forge.apiBase,
        `/repos/${forge.project}/actions/runs?branch=${enc}&per_page=1`,
        token,
        ctrl.signal,
      ),
    ]);
    const list = Array.isArray(prs) ? prs : [];
    const open = list.find((p) => p.state === "open");
    const pr = open || list[0] || null;
    const merged = list.some((p) => Boolean(p.merged_at));
    const run = Array.isArray(runs?.workflow_runs)
      ? runs.workflow_runs[0]
      : null;
    const prState = (p) =>
      p.state === "open" ? "opened" : p.merged_at ? "merged" : "closed";
    return {
      configured: true,
      provider: "github",
      branch,
      fetchedAt: new Date().toISOString(),
      merged,
      mr: pr
        ? {
            iid: pr.number,
            title: pr.title,
            state: prState(pr),
            draft: Boolean(pr.draft),
            hasConflicts: false,
            notes: 0,
            target: pr.base?.ref ?? null,
            webUrl: pr.html_url,
            updatedAt: pr.updated_at,
            mergedAt: pr.merged_at ?? null,
          }
        : null,
      pipeline: run
        ? {
            id: run.id,
            status: runStatus(run),
            sha: String(run.head_sha || "").slice(0, 9),
            webUrl: run.html_url,
            updatedAt: run.updated_at,
          }
        : null,
    };
  } catch (e) {
    const aborted = e && /** @type {any} */ (e).name === "AbortError";
    return {
      configured: true,
      provider: "github",
      branch,
      error: aborted ? "timed out" : String((e && e.message) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}
