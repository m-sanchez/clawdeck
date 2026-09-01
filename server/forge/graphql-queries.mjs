// @ts-check
/**
 * Frozen read-only GraphQL documents. Every document here is an `query`
 * operation; no mutation may ever be added to this file, and a test asserts
 * that. GitHub exposes review-thread resolution and the overall review decision
 * only through GraphQL, which is why POST is permitted for these reads.
 */

/**
 * Review threads for one pull request, plus the repository-level review
 * decision. Paginated with the same bound as the REST reads so the resolution
 * coverage axis stays honest.
 */
export const GITHUB_REVIEW_THREADS = `
query ClawdeckReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          resolvedBy { login }
          comments(first: 1) { nodes { databaseId } }
        }
      }
    }
  }
}`.trim();

/** Operation type of a document, for the read-only assertion. */
export function operationType(document) {
  const m = /^\s*(query|mutation|subscription)\b/.exec(String(document || ""));
  return m ? m[1] : "unknown";
}
