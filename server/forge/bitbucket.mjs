// @ts-check
/**
 * Read-only Bitbucket Cloud connector: the branch's pull request and latest
 * pipeline via API 2.0, mapped to the normalized forge shape. Auth is a
 * workspace/repository access token as a Bearer header.
 */

async function get(apiBase, path, token, signal) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${apiBase}${path}`, { headers, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function bitbucketNewMrUrl(forge, branch) {
  return `${forge.webBase}/${forge.project}/pull-requests/new?source=${encodeURIComponent(branch || "")}`;
}

function prState(pr) {
  if (pr.state === "OPEN") return "opened";
  if (pr.state === "MERGED") return "merged";
  return "closed";
}

function pipeStatus(p) {
  const s = p?.state?.result?.name || p?.state?.name || "";
  if (s === "SUCCESSFUL") return "success";
  if (s === "FAILED" || s === "ERROR") return "failed";
  if (s === "IN_PROGRESS" || s === "PENDING") return "running";
  if (s === "STOPPED") return "canceled";
  return s ? s.toLowerCase() : null;
}

export async function bitbucketStatus(forge, token, branch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const q = encodeURIComponent(`source.branch.name = "${branch}"`);
  try {
    const [prs, pipes] = await Promise.all([
      get(
        forge.apiBase,
        `/repositories/${forge.project}/pullrequests?q=${q}&state=OPEN&state=MERGED&state=DECLINED&pagelen=5&sort=-updated_on`,
        token,
        ctrl.signal,
      ),
      get(
        forge.apiBase,
        `/repositories/${forge.project}/pipelines/?target.branch=${encodeURIComponent(branch)}&pagelen=1&sort=-created_on`,
        token,
        ctrl.signal,
      ).catch(() => null),
    ]);
    const list = Array.isArray(prs?.values) ? prs.values : [];
    const pr = list.find((p) => p.state === "OPEN") || list[0] || null;
    const merged = list.some((p) => p.state === "MERGED");
    const pipe = Array.isArray(pipes?.values) ? pipes.values[0] : null;
    return {
      configured: true,
      provider: "bitbucket",
      branch,
      fetchedAt: new Date().toISOString(),
      merged,
      mr: pr
        ? {
            iid: pr.id,
            title: pr.title,
            state: prState(pr),
            draft: Boolean(pr.draft),
            // Bitbucket does not report it on this endpoint; unread is
            // unknown, never false.
            hasConflicts: null,
            notes: pr.comment_count ?? 0,
            target: pr.destination?.branch?.name ?? null,
            webUrl: pr.links?.html?.href ?? null,
            updatedAt: pr.updated_on ?? null,
            mergedAt: pr.state === "MERGED" ? (pr.updated_on ?? null) : null,
          }
        : null,
      pipeline: pipe
        ? {
            id: pipe.build_number ?? pipe.uuid,
            status: pipeStatus(pipe),
            sha: String(pipe.target?.commit?.hash || "").slice(0, 9),
            webUrl: null,
            updatedAt: pipe.created_on ?? null,
          }
        : null,
    };
  } catch (e) {
    const aborted = e && /** @type {any} */ (e).name === "AbortError";
    return {
      configured: true,
      provider: "bitbucket",
      branch,
      error: aborted ? "timed out" : String((e && e.message) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}
