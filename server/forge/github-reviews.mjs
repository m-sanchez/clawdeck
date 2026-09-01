// @ts-check
/**
 * GitHub review threads, read-only.
 *
 * REST gives the comments and their diff anchors but says nothing about
 * resolution; that lives in GraphQL. So: REST lists (works unauthenticated on
 * public repositories), and GraphQL enriches only when a token exists. Without
 * it `resolved` stays null - unknown, never false - and the resolution coverage
 * axis records why.
 *
 * `/pulls/{n}/comments` are review comments (resolvable, can block).
 * `/issues/{n}/comments` are the PR conversation (never an automatic blocker).
 */
import { makeThread, makeNote, coverage } from "../core/review-inbox/model.mjs";
import { GITHUB_REVIEW_THREADS } from "./graphql-queries.mjs";
import {
  capabilitiesFromObservations,
  headerOf,
  parseScopeHeader,
} from "./capabilities.mjs";

const TIMEOUT_MS = 8000;
const PER_PAGE = 100;
const MAX_PAGES = 5;

function headers(token) {
  const h = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/**
 * Paginate a REST collection. Page URLs are always constructed here from
 * `apiBase`; a `Link` header from the response is never followed.
 */
async function getAll(fetchImpl, apiBase, path, token, signal, obs) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${apiBase}${path}${sep}per_page=${PER_PAGE}&page=${page}`;
    const res = await fetchImpl(url, { headers: headers(token), signal });
    if (obs) {
      obs.restStatus = res.status ?? (res.ok ? 200 : null);
      obs.scopes =
        parseScopeHeader(headerOf(res, "x-oauth-scopes")) ?? obs.scopes ?? null;
      obs.rateLimitRemaining =
        headerOf(res, "x-ratelimit-remaining") ?? obs.rateLimitRemaining;
      obs.rateLimitReset =
        headerOf(res, "x-ratelimit-reset") ?? obs.rateLimitReset;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error("unexpected payload");
    items.push(...batch);
    if (batch.length < PER_PAGE) return { items, complete: true };
  }
  return { items, complete: false };
}

/** Resolution/outdated per root comment id. Requires a token by construction. */
async function graphqlThreads(fetchImpl, forge, token, number, signal, obs) {
  const [owner, name] = forge.project.split("/");
  const byRootId = new Map();
  let after = null;
  let reviewDecision = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl(`${forge.apiBase}/graphql`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({
        query: GITHUB_REVIEW_THREADS,
        variables: { owner, name, number: Number(number), after },
      }),
      signal,
    });
    if (obs) obs.graphqlStatus = res.status ?? (res.ok ? 200 : null);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json?.errors?.length) throw new Error("graphql error");
    const pr = json?.data?.repository?.pullRequest;
    if (!pr) throw new Error("no pull request in graphql payload");
    reviewDecision = pr.reviewDecision ?? reviewDecision;
    for (const node of pr.reviewThreads?.nodes || []) {
      const rootId = node?.comments?.nodes?.[0]?.databaseId;
      if (rootId == null) continue;
      byRootId.set(String(rootId), {
        resolved: node.isResolved === true,
        outdated: typeof node.isOutdated === "boolean" ? node.isOutdated : null,
        resolvedBy: node.resolvedBy?.login ?? null,
      });
    }
    if (!pr.reviewThreads?.pageInfo?.hasNextPage) {
      return { byRootId, reviewDecision, complete: true };
    }
    after = pr.reviewThreads.pageInfo.endCursor;
  }
  return { byRootId, reviewDecision, complete: false };
}

/**
 * A line number only means something against the commit it was measured on,
 * and GitHub reports two frames: `line` is the position on `commit_id` (the
 * newest commit it could still map the comment to), while `original_line` is
 * the position on `original_commit_id` where the comment was written. Taking
 * the line from one frame and the commit from the other maps the anchor twice
 * and lands on a line nobody reviewed - so the pair is chosen together, newest
 * first, and `line: null` (the comment could not be mapped forward) falls back
 * to the original pair.
 */
function anchorOf(root) {
  const current =
    root.line != null && root.commit_id
      ? { line: root.line, sha: root.commit_id }
      : null;
  const original =
    root.original_line != null && (root.original_commit_id || root.commit_id)
      ? {
          line: root.original_line,
          sha: root.original_commit_id ?? root.commit_id,
        }
      : null;
  const pick = current ?? original;
  return {
    file: root.path ?? null,
    line: pick?.line ?? null,
    side: root.side === "LEFT" ? "old" : "new",
    anchorCommitSha: pick?.sha ?? null,
  };
}

/** Group review comments into threads by their root (`in_reply_to_id ?? id`). */
function groupThreads(comments) {
  const roots = new Map();
  for (const c of comments) {
    const rootId = String(c.in_reply_to_id ?? c.id);
    if (!roots.has(rootId)) roots.set(rootId, []);
    roots.get(rootId).push(c);
  }
  for (const list of roots.values()) {
    list.sort(
      (a, b) => Date.parse(a.created_at || "") - Date.parse(b.created_at || ""),
    );
  }
  return roots;
}

/**
 * @param {{provider:string, apiBase:string, webBase:string, project:string}} forge
 * @param {string|null} token
 * @param {{iid:number|string}} mr
 * @param {{fetchImpl?:Function, now?:number}} [opts]
 */
export async function githubReviewThreads(forge, token, mr, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now ?? Date.now();
  const observedAt = new Date(now).toISOString();
  const number = mr?.iid;
  if (number == null) {
    return {
      ok: false,
      reason: "no-change",
      provider: "github",
      threads: [],
      notes: [],
      coverage: { threads: coverage(false, "no pull request") },
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const degraded = [];
  // Capabilities are derived from what the provider actually answered, so the
  // observations are collected as the calls happen.
  const obs = { authenticated: Boolean(token), now };
  try {
    const [reviewComments, issueComments] = await Promise.all([
      getAll(
        fetchImpl,
        forge.apiBase,
        `/repos/${forge.project}/pulls/${number}/comments`,
        token,
        ctrl.signal,
        obs,
      ),
      getAll(
        fetchImpl,
        forge.apiBase,
        `/repos/${forge.project}/issues/${number}/comments`,
        token,
        ctrl.signal,
      ).catch(() => ({ items: [], complete: false })),
    ]);

    // Resolution is GraphQL-only, and GitHub's GraphQL endpoint always rejects
    // anonymous requests - so without a token we do not ask.
    let enrichment = { byRootId: new Map(), reviewDecision: null };
    let resolutionComplete = false;
    if (token) {
      try {
        enrichment = await graphqlThreads(
          fetchImpl,
          forge,
          token,
          number,
          ctrl.signal,
          obs,
        );
        resolutionComplete = enrichment.complete === true;
      } catch {
        degraded.push("github-graphql-unavailable");
      }
    } else {
      degraded.push("github-graphql-requires-token");
    }

    const threads = [];
    for (const [rootId, list] of groupThreads(reviewComments.items)) {
      const root = list[0];
      const enriched = enrichment.byRootId.get(rootId) || null;
      threads.push(
        makeThread({
          provider: "github",
          repository: forge.project,
          changeId: String(number),
          remoteThreadId: rootId,
          remoteUrl: root.html_url ?? null,
          author: root.user?.login ?? null,
          createdAt: root.created_at ?? null,
          updatedAt: list[list.length - 1]?.updated_at ?? root.updated_at,
          observedAt,
          location: anchorOf(root),
          remote: {
            resolved: enriched ? enriched.resolved : null,
            resolvable: true,
            outdated: enriched ? enriched.outdated : null,
            resolvedBy: enriched ? enriched.resolvedBy : null,
            source: enriched ? "graphql" : "rest",
          },
          // Kept apart from the provider's own `outdated`: a null position only
          // hints the anchor moved.
          anchorOutdatedInferred: root.position == null ? true : false,
          comments: list.map((c) => ({
            author: c.user?.login ?? null,
            createdAt: c.created_at ?? null,
            body: c.body ?? "",
          })),
        }),
      );
    }

    const notes = issueComments.items.map((c) =>
      makeNote({
        provider: "github",
        repository: forge.project,
        changeId: String(number),
        remoteThreadId: String(c.id),
        remoteUrl: c.html_url ?? null,
        author: c.user?.login ?? null,
        createdAt: c.created_at ?? null,
        updatedAt: c.updated_at ?? null,
        comments: [
          {
            author: c.user?.login ?? null,
            createdAt: c.created_at ?? null,
            body: c.body ?? "",
          },
        ],
      }),
    );

    // Listing every thread does not mean knowing every resolution: the two
    // axes are tracked apart so "0 unresolved" can never be read as "clear"
    // when only some threads were enriched.
    const enrichedAll = threads.every(
      (t) => t.remote.source === "graphql" || t.remote.resolved !== null,
    );
    obs.restComplete = reviewComments.complete;
    obs.resolutionInPayload = enrichment.byRootId.size > 0;
    obs.outdatedInPayload = [...enrichment.byRootId.values()].some(
      (v) => typeof v.outdated === "boolean",
    );
    return {
      ok: true,
      provider: "github",
      capabilities: capabilitiesFromObservations("github", obs),
      changeId: String(number),
      reviewDecision: enrichment.reviewDecision ?? null,
      threads,
      notes,
      degraded,
      observedAt,
      coverage: {
        threads: coverage(
          reviewComments.complete,
          reviewComments.complete ? undefined : "pagination cap",
        ),
        notes: coverage(issueComments.complete),
        resolution: coverage(
          Boolean(token) && resolutionComplete && enrichedAll,
          token
            ? resolutionComplete
              ? enrichedAll
                ? undefined
                : "some threads not enriched"
              : "graphql pagination cap"
            : "resolution requires a token",
        ),
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: "fetch-failed",
      provider: "github",
      capabilities: capabilitiesFromObservations("github", obs),
      error: String(error?.message || error),
      threads: [],
      notes: [],
      degraded,
      coverage: { threads: coverage(false, "fetch failed") },
    };
  } finally {
    clearTimeout(timer);
  }
}
