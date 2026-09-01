// @ts-check
/**
 * Builders for provider review payloads. Functions, not static JSON, so a test
 * states only the field it cares about and the rest stays realistic.
 */

/** A GitHub review comment (`/pulls/{n}/comments`). */
export function ghReviewComment(overrides = {}) {
  return {
    id: 1001,
    in_reply_to_id: undefined,
    path: "src/auth/token.ts",
    line: 84,
    original_line: 84,
    position: 12,
    side: "RIGHT",
    commit_id: "c0ffee1",
    original_commit_id: "anchor1",
    user: { login: "sarah" },
    body: "Why are we comparing the token directly here?",
    html_url: "https://github.com/o/r/pull/184#discussion_r1001",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

/** A GitHub PR conversation comment (`/issues/{n}/comments`). */
export function ghIssueComment(overrides = {}) {
  return {
    id: 5001,
    user: { login: "james" },
    body: "Looks good, just one thought about naming.",
    html_url: "https://github.com/o/r/pull/184#issuecomment-5001",
    created_at: "2026-09-01T11:00:00Z",
    updated_at: "2026-09-01T11:00:00Z",
    ...overrides,
  };
}

/** A GraphQL reviewThreads page. */
export function ghGraphqlPage(
  nodes,
  {
    hasNextPage = false,
    endCursor = null,
    reviewDecision = "REVIEW_REQUIRED",
  } = {},
) {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewDecision,
          reviewThreads: {
            pageInfo: { hasNextPage, endCursor },
            nodes,
          },
        },
      },
    },
  };
}

/** One GraphQL reviewThread node keyed to a REST root comment id. */
export function ghThreadNode(rootDatabaseId, overrides = {}) {
  return {
    isResolved: false,
    isOutdated: false,
    resolvedBy: null,
    comments: { nodes: [{ databaseId: rootDatabaseId }] },
    ...overrides,
  };
}

/** A GitLab discussion (`/merge_requests/{iid}/discussions`). */
export function glDiscussion(overrides = {}) {
  return {
    id: "d1",
    individual_note: false,
    notes: [
      glNote({
        id: 9001,
        body: "This cache invalidation is not obvious.",
        resolvable: true,
        resolved: false,
      }),
    ],
    ...overrides,
  };
}

/** One GitLab note. */
export function glNote(overrides = {}) {
  return {
    id: 9001,
    type: "DiffNote",
    system: false,
    resolvable: true,
    resolved: false,
    resolved_by: null,
    author: { username: "sarah" },
    body: "note body",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    position: {
      new_path: "server/lib/cache.mjs",
      old_path: "server/lib/cache.mjs",
      new_line: 191,
      old_line: null,
      head_sha: "anchor1",
      base_sha: "base1",
      start_sha: "start1",
    },
    ...overrides,
  };
}

/**
 * A `fetch` stub over a map of URL-substring → response spec. Records every
 * call so a test can assert method, headers and that no page URL came from a
 * Link header.
 */
export function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", init });
    for (const [needle, spec] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        const value =
          typeof spec === "function" ? spec(String(url), init) : spec;
        if (value?.status && value.status >= 400) {
          return { ok: false, status: value.status, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => value?.body ?? value,
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

export const FORGE = {
  provider: "github",
  apiBase: "https://api.github.com",
  webBase: "https://github.com",
  project: "o/r",
};

export const GL_FORGE = {
  provider: "gitlab",
  apiBase: "https://gitlab.example.com/api/v4",
  webBase: "https://gitlab.example.com",
  project: "group/app",
};
