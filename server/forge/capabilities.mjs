// @ts-check
/**
 * What a forge connection can actually do, derived from what the provider
 * answered - never from whether a token happens to be set.
 *
 * A token can exist and be scoped read-only; it can be valid for REST and
 * rejected for GraphQL. So every field here comes from an observation: a status
 * code, a scope header, the shape of a payload. Anything unobserved stays
 * `"unknown"`, which is what a later write gate must refuse on.
 *
 * Pure: it reads recorded observations, never the network.
 */

export const EMPTY_CAPABILITIES = Object.freeze({
  provider: null,
  probedAt: null,
  auth: "none",
  read: {
    threads: "unavailable",
    resolution: "unavailable",
    outdated: "unavailable",
  },
  write: { reply: "unknown", resolve: "unknown" },
  scopes: null,
  rateLimit: { remaining: null, resetAt: null },
  evidence: [],
});

/** Scopes that permit writing a review comment, per provider. */
const WRITE_SCOPES = {
  github: ["repo", "public_repo"],
  gitlab: ["api"],
};

function scopeVerdict(provider, scopes) {
  // No scope evidence at all (fine-grained PATs omit the header) - the honest
  // answer is that we do not know, and a write gate must treat that as no.
  if (!Array.isArray(scopes)) return "unknown";
  const allowed = WRITE_SCOPES[provider] || [];
  return scopes.some((s) => allowed.includes(s)) ? "allowed" : "forbidden";
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {string} provider
 * @param {{
 *   authenticated?: boolean,
 *   restStatus?: number|null,
 *   restComplete?: boolean,
 *   graphqlStatus?: number|null,
 *   resolutionInPayload?: boolean,
 *   outdatedInPayload?: boolean,
 *   scopes?: string[]|null,
 *   rateLimitRemaining?: string|number|null,
 *   rateLimitReset?: string|number|null,
 *   now?: number,
 * }} obs
 */
export function capabilitiesFromObservations(provider, obs = {}) {
  const evidence = [];
  const now = obs.now ?? Date.now();

  const restOk = obs.restStatus === 200;
  if (obs.restStatus != null) evidence.push(`rest:${obs.restStatus}`);
  if (obs.graphqlStatus != null) evidence.push(`graphql:${obs.graphqlStatus}`);

  const threads = !restOk
    ? "unavailable"
    : obs.restComplete === false
      ? "partial"
      : "ok";

  // Resolution is only "ok" when a payload actually carried it: GitHub needs a
  // successful GraphQL read, GitLab carries it inline on the discussion.
  const resolution = obs.resolutionInPayload === true ? "ok" : "unavailable";
  if (obs.resolutionInPayload === true) evidence.push("payload:resolution");

  // `outdated` reported by the provider is "ok"; a head-sha comparison of our
  // own is "inferred" and must never be presented as the provider's word.
  const outdated =
    obs.outdatedInPayload === true ? "ok" : restOk ? "inferred" : "unavailable";

  const scopes = Array.isArray(obs.scopes) ? obs.scopes : null;
  if (scopes) evidence.push(`scopes:${scopes.join(",") || "(none)"}`);
  const writeVerdict = scopeVerdict(provider, scopes);

  return {
    provider,
    probedAt: new Date(now).toISOString(),
    auth: obs.authenticated ? "token" : "none",
    read: { threads, resolution, outdated },
    // Both writes need the same scope today; they are separate fields so a
    // provider that splits them later does not need a shape change.
    write: { reply: writeVerdict, resolve: writeVerdict },
    scopes,
    rateLimit: {
      remaining: numberOrNull(obs.rateLimitRemaining),
      resetAt: obs.rateLimitReset
        ? new Date(Number(obs.rateLimitReset) * 1000).toISOString()
        : null,
    },
    evidence,
  };
}

/** Read a header from a fetch Response without assuming a full implementation. */
export function headerOf(response, name) {
  try {
    const value = response?.headers?.get?.(name);
    return value == null ? null : String(value);
  } catch {
    return null;
  }
}

/** `x-oauth-scopes: repo, read:org` → ["repo","read:org"]; absent → null. */
export function parseScopeHeader(value) {
  if (value == null) return null;
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
