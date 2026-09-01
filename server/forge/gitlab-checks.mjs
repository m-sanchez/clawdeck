// @ts-check
/**
 * GitLab CI state for a commit, read-only.
 *
 * Same rule as the GitHub side: the pipeline is not the whole gate. GitLab lets
 * external systems post commit statuses alongside it, so both are read and an
 * incomplete read can only ever be `unknown`.
 */
import { summarize } from "./github-checks.mjs";

const TIMEOUT_MS = 8000;
const PER_PAGE = 100;

function jobState(status) {
  switch (status) {
    case "success":
      return "passing";
    case "skipped":
    case "manual":
      return "passing";
    case "failed":
      return "failing";
    case "canceled":
      return "cancelled";
    case "created":
    case "pending":
    case "running":
    case "waiting_for_resource":
    case "preparing":
      return "pending";
    default:
      return "unknown";
  }
}

/**
 * @param {{apiBase:string, webBase:string, project:string}} forge
 * @param {string|null} token
 * @param {{sha:string|null, pipelineId?:number|string|null}} ref
 * @param {{fetchImpl?:Function, now?:number}} [opts]
 */
export async function gitlabChecks(forge, token, ref, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now ?? Date.now();
  const observedAt = new Date(now).toISOString();
  const sha = ref?.sha ?? null;

  if (!token || !sha)
    return {
      ok: false,
      reason: token ? "no head commit to check" : "a GitLab token is required",
      provider: "gitlab",
      summary: summarize([], {
        observedAt,
        complete: false,
        reason: token ? "no head commit" : "a token is required",
      }),
      contexts: [],
      failures: [],
      observedAt,
    };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const project = encodeURIComponent(forge.project);
  const get = async (path) => {
    const res = await fetchImpl(`${forge.apiBase}${path}`, {
      headers: { "PRIVATE-TOKEN": token },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  try {
    // Commit statuses carry both the pipeline's own jobs and anything external
    // that posted against this commit, which is why they are the primary read.
    const [statuses, jobs] = await Promise.allSettled([
      get(
        `/projects/${project}/repository/commits/${sha}/statuses?per_page=${PER_PAGE}`,
      ),
      ref.pipelineId
        ? get(
            `/projects/${project}/pipelines/${ref.pipelineId}/jobs?per_page=${PER_PAGE}`,
          )
        : Promise.resolve([]),
    ]);

    const contexts = [];
    const byName = new Set();
    if (statuses.status === "fulfilled") {
      for (const st of statuses.value ?? []) {
        byName.add(st.name);
        contexts.push({
          name: st.name,
          state: jobState(st.status),
          source: st.allow_failure ? "commit-status" : "check-run",
          id: st.id,
          detailsUrl: st.target_url ?? null,
          inspectable: false,
          startedAt: st.started_at ?? st.created_at ?? null,
          completedAt: st.finished_at ?? null,
        });
      }
    }
    // Pipeline jobs add the part Clawdeck can actually fetch logs for.
    if (jobs.status === "fulfilled") {
      for (const job of Array.isArray(jobs.value) ? jobs.value : []) {
        const existing = contexts.find((c) => c.name === job.name);
        if (existing) {
          existing.inspectable = true;
          existing.jobId = job.id;
          continue;
        }
        contexts.push({
          name: job.name,
          state: jobState(job.status),
          source: "check-run",
          id: job.id,
          jobId: job.id,
          detailsUrl: job.web_url ?? null,
          inspectable: true,
          startedAt: job.started_at ?? null,
          completedAt: job.finished_at ?? null,
        });
      }
    }

    const complete =
      statuses.status === "fulfilled" &&
      (!ref.pipelineId || jobs.status === "fulfilled");
    return {
      ok: true,
      provider: "gitlab",
      ref: sha,
      summary: summarize(contexts, {
        observedAt,
        complete,
        reason: complete
          ? undefined
          : statuses.status === "fulfilled"
            ? "pipeline jobs could not be read"
            : "commit statuses could not be read",
      }),
      contexts,
      failures: contexts.filter((c) => c.state === "failing"),
      observedAt,
    };
  } catch (error) {
    return {
      ok: false,
      reason: String(error?.message || error),
      provider: "gitlab",
      summary: summarize([], {
        observedAt,
        complete: false,
        reason: "the provider did not answer",
      }),
      contexts: [],
      failures: [],
      observedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
