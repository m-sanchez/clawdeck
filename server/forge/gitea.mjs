// @ts-check
/**
 * Read-only Gitea/Forgejo connector: the branch's pull request (list filtered
 * client-side; the list API has no head filter) and the branch's combined
 * commit status, mapped to the normalized forge shape.
 */

async function get(apiBase, path, token, signal) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `token ${token}`;
  const res = await fetch(`${apiBase}${path}`, { headers, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function giteaNewMrUrl(forge, branch, target) {
  return `${forge.webBase}/${forge.project}/compare/${encodeURIComponent(target)}...${encodeURIComponent(branch || "")}`;
}

function statusWord(s) {
  if (s === "success") return "success";
  if (s === "failure" || s === "error") return "failed";
  if (s === "pending") return "running";
  return s || null;
}

export async function giteaStatus(forge, token, branch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const [pulls, status] = await Promise.all([
      get(
        forge.apiBase,
        `/repos/${forge.project}/pulls?state=all&sort=recentupdate&limit=30`,
        token,
        ctrl.signal,
      ),
      get(
        forge.apiBase,
        `/repos/${forge.project}/commits/${encodeURIComponent(branch)}/status`,
        token,
        ctrl.signal,
      ).catch(() => null),
    ]);
    const mine = (Array.isArray(pulls) ? pulls : []).filter(
      (p) => p.head?.ref === branch,
    );
    const pr = mine.find((p) => p.state === "open") || mine[0] || null;
    const merged = mine.some((p) => Boolean(p.merged_at));
    const prState = (p) =>
      p.state === "open" ? "opened" : p.merged_at ? "merged" : "closed";
    return {
      configured: true,
      provider: "gitea",
      branch,
      fetchedAt: new Date().toISOString(),
      merged,
      mr: pr
        ? {
            iid: pr.number,
            title: pr.title,
            state: prState(pr),
            draft: Boolean(pr.draft),
            hasConflicts: pr.mergeable === false,
            notes: pr.comments ?? 0,
            target: pr.base?.ref ?? null,
            webUrl: pr.html_url ?? null,
            updatedAt: pr.updated_at ?? null,
            mergedAt: pr.merged_at ?? null,
          }
        : null,
      pipeline: status?.state
        ? {
            id: status.sha ? status.sha.slice(0, 9) : "status",
            status: statusWord(status.state),
            sha: String(status.sha || "").slice(0, 9),
            webUrl: null,
            updatedAt: null,
          }
        : null,
    };
  } catch (e) {
    const aborted = e && /** @type {any} */ (e).name === "AbortError";
    return {
      configured: true,
      provider: "gitea",
      branch,
      error: aborted ? "timed out" : String((e && e.message) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}
