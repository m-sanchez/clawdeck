// @ts-check
/**
 * GitHub CI state for a commit, read-only.
 *
 * "All the Actions jobs are green" is not the same as "CI passed". A pull
 * request can be gated by external apps and by legacy commit statuses that
 * Actions knows nothing about, so the summary is built from BOTH the check-runs
 * and the combined commit status for the head SHA. If only some of that could
 * be read, the summary says so rather than reporting a green it cannot support.
 *
 * Failed jobs are drill-down detail. An empty failure list never implies green.
 */
import { coverage } from "../core/review-inbox/model.mjs";

const TIMEOUT_MS = 8000;
const PER_PAGE = 100;

function headers(token) {
  const h = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/** One check-run's state in the vocabulary the summary uses. */
function checkState(run) {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return "passing";
    case "cancelled":
      return "cancelled";
    case "action_required":
    case "failure":
    case "timed_out":
    case "stale":
      return "failing";
    default:
      return "unknown";
  }
}

/** A legacy commit status, same vocabulary. */
function statusState(state) {
  switch (state) {
    case "success":
      return "passing";
    case "pending":
      return "pending";
    case "failure":
    case "error":
      return "failing";
    default:
      return "unknown";
  }
}

/**
 * @param {{apiBase:string, webBase:string, project:string}} forge
 * @param {string|null} token
 * @param {string} ref the head SHA of the change
 * @param {{fetchImpl?:Function, now?:number}} [opts]
 */
export async function githubChecks(forge, token, ref, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now ?? Date.now();
  const observedAt = new Date(now).toISOString();
  if (!ref) return unavailable("no head commit to check", observedAt);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const get = async (path) => {
    const res = await fetchImpl(`${forge.apiBase}${path}`, {
      headers: headers(token),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  try {
    // Both sources are asked for; either failing narrows what can be claimed.
    const [checkRuns, combined] = await Promise.allSettled([
      get(
        `/repos/${forge.project}/commits/${ref}/check-runs?per_page=${PER_PAGE}`,
      ),
      get(`/repos/${forge.project}/commits/${ref}/status?per_page=${PER_PAGE}`),
    ]);

    const contexts = [];
    let checksComplete = false;
    if (checkRuns.status === "fulfilled") {
      const runs = checkRuns.value?.check_runs ?? [];
      checksComplete =
        runs.length >= (checkRuns.value?.total_count ?? runs.length);
      for (const run of runs)
        contexts.push({
          name: run.name,
          state: checkState(run),
          source: "check-run",
          id: run.id,
          detailsUrl: run.details_url ?? run.html_url ?? null,
          // Only Actions runs have logs Clawdeck can fetch; an external app's
          // check has a URL and nothing more.
          inspectable: Boolean(run.app?.slug === "github-actions"),
          startedAt: run.started_at ?? null,
          completedAt: run.completed_at ?? null,
        });
    }

    let statusesComplete = false;
    if (combined.status === "fulfilled") {
      const statuses = combined.value?.statuses ?? [];
      statusesComplete = true;
      for (const st of statuses)
        contexts.push({
          name: st.context,
          state: statusState(st.state),
          source: "commit-status",
          id: st.id,
          detailsUrl: st.target_url ?? null,
          inspectable: false,
          startedAt: st.created_at ?? null,
          completedAt: st.updated_at ?? null,
        });
    }

    const complete = checksComplete && statusesComplete;
    const summary = summarize(contexts, {
      observedAt,
      complete,
      reason: complete
        ? undefined
        : checkRuns.status === "fulfilled"
          ? "commit statuses could not be read"
          : "check runs could not be read",
    });

    return {
      ok: true,
      provider: "github",
      ref,
      summary,
      contexts,
      failures: contexts.filter((c) => c.state === "failing"),
      observedAt,
    };
  } catch (error) {
    return {
      ...unavailable(String(error?.message || error), observedAt),
      provider: "github",
      ref,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fold context states into one answer. Failing beats pending beats passing, and
 * an incomplete read can never produce `passing` - only `unknown`, because the
 * context that would have failed may be the one we could not see.
 */
export function summarize(contexts, { observedAt, complete, reason } = {}) {
  const cov = coverage(Boolean(complete), reason);
  if (!contexts.length)
    return {
      state: complete ? "missing" : "unknown",
      authority: "ci",
      observedAt: observedAt ?? null,
      coverage: cov,
      counts: { total: 0, passing: 0, failing: 0, pending: 0 },
      native: false,
    };

  const counts = {
    total: contexts.length,
    passing: contexts.filter((c) => c.state === "passing").length,
    failing: contexts.filter((c) => c.state === "failing").length,
    pending: contexts.filter((c) => c.state === "pending").length,
  };
  const state = counts.failing
    ? "failing"
    : counts.pending
      ? "pending"
      : complete
        ? "passing"
        : "unknown";

  return {
    state,
    authority: "ci",
    observedAt: observedAt ?? null,
    coverage: cov,
    counts,
    // True when everything read came from one provider's own runner, so the UI
    // can say "native CI" rather than implying the whole gate was seen.
    native: contexts.every((c) => c.source === "check-run"),
  };
}

function unavailable(reason, observedAt) {
  return {
    ok: false,
    reason,
    summary: {
      state: "unknown",
      authority: "ci",
      observedAt,
      coverage: coverage(false, reason),
      counts: { total: 0, passing: 0, failing: 0, pending: 0 },
      native: false,
    },
    contexts: [],
    failures: [],
    observedAt,
  };
}
