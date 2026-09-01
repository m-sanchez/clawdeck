// @ts-check
/**
 * Forge facade: detect the provider for a checkout, then answer status and
 * new-MR-URL queries in one normalized shape regardless of provider. Everything
 * degrades to `{ configured: false }` when no forge is detected or (for GitLab)
 * no token is available, so the panel stays useful offline.
 *
 * Connectors: GitHub, GitLab, Bitbucket Cloud, Gitea/Forgejo, Azure DevOps.
 */
import { detectForge, forgeToken } from "./provider.mjs";
import { gitlabStatus, gitlabNewMrUrl } from "./gitlab.mjs";
import { githubStatus, githubNewMrUrl } from "./github.mjs";
import { bitbucketStatus, bitbucketNewMrUrl } from "./bitbucket.mjs";
import { giteaStatus, giteaNewMrUrl } from "./gitea.mjs";
import { azureStatus, azureNewMrUrl } from "./azure.mjs";
import { githubReviewThreads } from "./github-reviews.mjs";
import { gitlabReviewThreads } from "./gitlab-reviews.mjs";
import { githubChecks } from "./github-checks.mjs";
import { gitlabChecks } from "./gitlab-checks.mjs";

const DETECT_TTL_MS = 60000;
const detectCache = new Map();

async function forgeFor(checkoutRoot) {
  const hit = detectCache.get(checkoutRoot);
  if (hit && Date.now() - hit.at < DETECT_TTL_MS) return hit.forge;
  const forge = await detectForge(checkoutRoot);
  detectCache.set(checkoutRoot, { forge, at: Date.now() });
  return forge;
}

/**
 * Branch status from the detected forge (MR/PR + latest pipeline/run).
 * @returns {Promise<object>} always an object; `configured:false` when absent.
 */
export async function getForgeStatus(checkoutRoot, branch) {
  const forge = await forgeFor(checkoutRoot);
  if (!forge) return { configured: false };
  const token = forgeToken(checkoutRoot, forge.provider);
  // GitHub and Gitea answer unauthenticated for public repos; the others
  // effectively never do, so tokenless there reads as unconfigured.
  const tokenOptional =
    forge.provider === "github" || forge.provider === "gitea";
  if (!token && !tokenOptional) return { configured: false };
  if (!branch)
    return {
      configured: true,
      provider: forge.provider,
      branch: null,
      mr: null,
      pipeline: null,
    };
  const impl = {
    github: githubStatus,
    gitlab: gitlabStatus,
    bitbucket: bitbucketStatus,
    gitea: giteaStatus,
    azuredevops: azureStatus,
  }[forge.provider];
  return impl ? impl(forge, token, branch) : { configured: false };
}

/**
 * Review discussions for an open change, read-only. Only GitHub and GitLab are
 * implemented; every other provider degrades to `unsupported` so the UI can say
 * which case it is rather than showing an empty list.
 *
 * The token's lexical scope ends here: nothing downstream takes one.
 *
 * @param {string} checkoutRoot
 * @param {{iid:number|string}|null} mr
 * @param {{fetchImpl?:Function, now?:number}} [opts]
 */
export async function getReviewThreads(checkoutRoot, mr, opts = {}) {
  const forge = await forgeFor(checkoutRoot);
  if (!forge)
    return {
      ok: false,
      reason: "no-remote",
      provider: null,
      threads: [],
      notes: [],
    };

  const impl = {
    github: githubReviewThreads,
    gitlab: gitlabReviewThreads,
  }[forge.provider];
  if (!impl)
    return {
      ok: false,
      reason: "unsupported",
      provider: forge.provider,
      threads: [],
      notes: [],
    };

  const token = forgeToken(checkoutRoot, forge.provider);
  return impl(forge, token, mr, opts);
}

/**
 * CI state for a commit, read-only. Only GitHub and GitLab are implemented;
 * anything else degrades to unsupported so the UI can say which case it is
 * rather than showing an absence that looks like a pass.
 *
 * @param {string} checkoutRoot
 * @param {{sha:string|null, pipelineId?:number|string|null}} ref
 * @param {{fetchImpl?:Function, now?:number}} [opts]
 */
export async function getChecks(checkoutRoot, ref, opts = {}) {
  const forge = await forgeFor(checkoutRoot);
  if (!forge) return { ok: false, reason: "no-remote", provider: null };
  const token = forgeToken(checkoutRoot, forge.provider);
  if (forge.provider === "github")
    return githubChecks(forge, token, ref?.sha ?? null, opts);
  if (forge.provider === "gitlab") return gitlabChecks(forge, token, ref, opts);
  return { ok: false, reason: "unsupported", provider: forge.provider };
}

/** Web URL that opens a new MR/PR for the branch, or null when undetected. */
export async function newMrUrl(checkoutRoot, branch, target = "main") {
  const forge = await forgeFor(checkoutRoot);
  if (!forge) return null;
  const impl = {
    github: githubNewMrUrl,
    gitlab: gitlabNewMrUrl,
    bitbucket: bitbucketNewMrUrl,
    gitea: giteaNewMrUrl,
    azuredevops: azureNewMrUrl,
  }[forge.provider];
  return impl ? impl(forge, branch, target) : null;
}
