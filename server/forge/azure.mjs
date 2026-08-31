// @ts-check
/**
 * Read-only Azure DevOps connector: the branch's pull request and latest
 * build via the 7.0 REST API, mapped to the normalized forge shape. Auth is a
 * PAT sent as Basic with an empty username.
 */

function authHeader(token) {
  return "Basic " + Buffer.from(`:${token}`).toString("base64");
}

async function get(apiBase, path, token, signal) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = authHeader(token);
  const res = await fetch(`${apiBase}${path}`, { headers, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** forge.project = "<project>/<repo>". */
function split(forge) {
  const [project, repo] = String(forge.project).split("/");
  return { project, repo };
}

export function azureNewMrUrl(forge, branch, target) {
  const { project, repo } = split(forge);
  return `${forge.webBase}/${project}/_git/${repo}/pullrequestcreate?sourceRef=${encodeURIComponent(branch || "")}&targetRef=${encodeURIComponent(target)}`;
}

function prState(pr) {
  if (pr.status === "active") return "opened";
  if (pr.status === "completed") return "merged";
  return "closed";
}

function buildStatus(b) {
  if (!b) return null;
  if (b.status === "inProgress" || b.status === "notStarted") return "running";
  if (b.result === "succeeded") return "success";
  if (b.result === "canceled") return "canceled";
  if (b.result) return "failed";
  return null;
}

export async function azureStatus(forge, token, branch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const { project, repo } = split(forge);
  const ref = encodeURIComponent(`refs/heads/${branch}`);
  try {
    const [prs, builds] = await Promise.all([
      get(
        forge.apiBase,
        `/${project}/_apis/git/repositories/${repo}/pullrequests?searchCriteria.sourceRefName=${ref}&searchCriteria.status=all&$top=5&api-version=7.0`,
        token,
        ctrl.signal,
      ),
      get(
        forge.apiBase,
        `/${project}/_apis/build/builds?branchName=${ref}&$top=1&api-version=7.0`,
        token,
        ctrl.signal,
      ).catch(() => null),
    ]);
    const list = Array.isArray(prs?.value) ? prs.value : [];
    const pr = list.find((p) => p.status === "active") || list[0] || null;
    const merged = list.some((p) => p.status === "completed");
    const build = Array.isArray(builds?.value) ? builds.value[0] : null;
    return {
      configured: true,
      provider: "azuredevops",
      branch,
      fetchedAt: new Date().toISOString(),
      merged,
      mr: pr
        ? {
            iid: pr.pullRequestId,
            title: pr.title,
            state: prState(pr),
            draft: Boolean(pr.isDraft),
            hasConflicts: pr.mergeStatus === "conflicts",
            notes: 0,
            target: String(pr.targetRefName || "").replace("refs/heads/", ""),
            webUrl: `${forge.webBase}/${project}/_git/${repo}/pullrequest/${pr.pullRequestId}`,
            updatedAt: pr.creationDate ?? null,
            mergedAt: pr.closedDate ?? null,
          }
        : null,
      pipeline: build
        ? {
            id: build.id,
            status: buildStatus(build),
            sha: String(build.sourceVersion || "").slice(0, 9),
            webUrl: build._links?.web?.href ?? null,
            updatedAt: build.finishTime ?? build.startTime ?? null,
          }
        : null,
    };
  } catch (e) {
    const aborted = e && /** @type {any} */ (e).name === "AbortError";
    return {
      configured: true,
      provider: "azuredevops",
      branch,
      error: aborted ? "timed out" : String((e && e.message) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}
