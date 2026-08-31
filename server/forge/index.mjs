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
  const tokenOptional = forge.provider === "github" || forge.provider === "gitea";
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
