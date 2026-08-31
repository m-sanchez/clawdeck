// @ts-check
/**
 * Forge facade: detect the provider for a checkout, then answer status and
 * new-MR-URL queries in one normalized shape regardless of provider. Everything
 * degrades to `{ configured: false }` when no forge is detected or (for GitLab)
 * no token is available, so the panel stays useful offline.
 *
 * v0.1 connectors: GitHub, GitLab. Bitbucket / Gitea / Azure DevOps: roadmap.
 */
import { detectForge, forgeToken } from "./provider.mjs";
import { gitlabStatus, gitlabNewMrUrl } from "./gitlab.mjs";
import { githubStatus, githubNewMrUrl } from "./github.mjs";

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
  // GitHub answers unauthenticated for public repos; GitLab effectively never
  // does for the MR list, so treat a tokenless GitLab as unconfigured.
  if (!token && forge.provider === "gitlab") return { configured: false };
  if (!branch)
    return {
      configured: true,
      provider: forge.provider,
      branch: null,
      mr: null,
      pipeline: null,
    };
  return forge.provider === "github"
    ? githubStatus(forge, token, branch)
    : gitlabStatus(forge, token, branch);
}

/** Web URL that opens a new MR/PR for the branch, or null when undetected. */
export async function newMrUrl(checkoutRoot, branch, target = "main") {
  const forge = await forgeFor(checkoutRoot);
  if (!forge) return null;
  return forge.provider === "github"
    ? githubNewMrUrl(forge, branch, target)
    : gitlabNewMrUrl(forge, branch, target);
}
