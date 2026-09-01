// @ts-check
/**
 * Forge detection: which git hosting provider the observed checkout talks to,
 * derived from `git remote get-url origin` with env overrides. Tokens are read
 * server-side only - env, the checkout's settings.local.json, or (GitHub only,
 * last resort) the gh CLI already authenticated on this machine - and never
 * reach the browser.
 *
 * Providers: github, gitlab, bitbucket (Cloud), gitea/forgejo (env-forced,
 * since a self-hosted host name reveals nothing), azuredevops. Unknown hosts
 * default to gitlab, whose API shape most self-hosted forges follow.
 */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function remoteUrl(checkoutRoot) {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["-C", checkoutRoot, "remote", "get-url", "origin"],
      { encoding: "utf8", windowsHide: true, timeout: 4000 },
      (err, stdout) => resolvePromise(err ? "" : String(stdout).trim()),
    );
  });
}

/** Parse ssh (git@host:path.git) and http(s) remote forms into { host, path }. */
export function parseRemote(url) {
  if (!url) return null;
  let m =
    /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+):([\w./~-]+?)(?:\.git)?\/?$/.exec(url);
  if (m && !url.includes("://")) return { host: m[1], path: m[2] };
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    if (!u.hostname || !path) return null;
    return { host: u.hostname, path };
  } catch {
    return null;
  }
}

function settingsEnv(checkoutRoot, name) {
  if (process.env[name]) return process.env[name];
  try {
    const j = JSON.parse(
      readFileSync(
        join(checkoutRoot, ".claude", "settings.local.json"),
        "utf8",
      ),
    );
    return j?.env?.[name] || null;
  } catch {
    return null;
  }
}

const TOKEN_VARS = {
  github: "GITHUB_TOKEN",
  gitlab: "GITLAB_TOKEN",
  bitbucket: "BITBUCKET_TOKEN",
  gitea: "GITEA_TOKEN",
  azuredevops: "AZURE_DEVOPS_TOKEN",
};

// The gh CLI already holds a GitHub credential on this machine, and most
// people never set GITHUB_TOKEN as well. Asking it is the last resort, cached
// so a poll does not spawn a process every time, and skippable.
const GH_CLI_TTL_MS = 300000;
let ghCliCache = { at: 0, token: null };

function ghCliToken(runner) {
  if (process.env.CLAWDECK_NO_GH_CLI) return null;
  const now = Date.now();
  if (now - ghCliCache.at < GH_CLI_TTL_MS) return ghCliCache.token;
  let token = null;
  try {
    const run = runner || execFileSync;
    token =
      String(
        run("gh", ["auth", "token"], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ).trim() || null;
  } catch {
    token = null;
  }
  ghCliCache = { at: now, token };
  return token;
}

/**
 * Provider token for this checkout. Never logged or returned to the client.
 *
 * @param {string} checkoutRoot
 * @param {string} provider
 * @param {{ghRunner?:Function}} [opts] test seam for the CLI fallback
 */
export function forgeToken(checkoutRoot, provider, opts = {}) {
  const configured = settingsEnv(
    checkoutRoot,
    TOKEN_VARS[provider] || "GITLAB_TOKEN",
  );
  if (configured) return configured;
  return provider === "github" ? ghCliToken(opts.ghRunner) : null;
}

/** Test seam: forget any cached CLI answer. */
export function resetGhCliCache() {
  ghCliCache = { at: 0, token: null };
}

/**
 * Resolve the forge for a checkout: env overrides first, then the origin remote.
 * @returns {Promise<{ provider: 'github'|'gitlab', apiBase: string, webBase: string, project: string } | null>}
 */
export async function detectForge(checkoutRoot) {
  const forced = (process.env.FORGE_PROVIDER || "").toLowerCase();

  if (forced === "gitea" || (!forced && process.env.GITEA_URL)) {
    // Gitea/Forgejo hosts are indistinguishable from any self-hosted git, so
    // the provider is opt-in via env; project still comes from the remote.
    const webBase = (process.env.GITEA_URL || "").replace(/\/+$/, "");
    const parsedRemote = parseRemote(await remoteUrl(checkoutRoot));
    const project = process.env.GITEA_REPO || parsedRemote?.path || null;
    if (webBase && project)
      return {
        provider: "gitea",
        apiBase: `${webBase}/api/v1`,
        webBase,
        project,
      };
  }
  if (forced === "github" || (!forced && process.env.GITHUB_REPO)) {
    const project = process.env.GITHUB_REPO || null;
    if (project)
      return {
        provider: "github",
        apiBase: process.env.GITHUB_API_URL || "https://api.github.com",
        webBase: process.env.GITHUB_URL || "https://github.com",
        project,
      };
  }
  if (
    forced === "gitlab" ||
    (!forced && process.env.GITLAB_URL && process.env.GITLAB_PROJECT)
  ) {
    const webBase = (process.env.GITLAB_URL || "").replace(/\/+$/, "");
    const project = process.env.GITLAB_PROJECT || null;
    if (webBase && project)
      return {
        provider: "gitlab",
        apiBase: `${webBase}/api/v4`,
        webBase,
        project,
      };
  }

  const parsed = parseRemote(await remoteUrl(checkoutRoot));
  if (!parsed) return null;
  const { host, path } = parsed;
  if (/(^|\.)bitbucket\.org$/.test(host))
    return {
      provider: "bitbucket",
      apiBase: "https://api.bitbucket.org/2.0",
      webBase: "https://bitbucket.org",
      project: path.split("/").slice(0, 2).join("/"),
    };
  if (host === "dev.azure.com" || host === "ssh.dev.azure.com") {
    // https://dev.azure.com/{org}/{project}/_git/{repo} or ssh v3:{org}/{project}/{repo}
    const segs = path
      .replace(/^v3\//, "")
      .split("/")
      .filter((x) => x !== "_git");
    if (segs.length >= 3)
      return {
        provider: "azuredevops",
        apiBase: `https://dev.azure.com/${segs[0]}`,
        webBase: `https://dev.azure.com/${segs[0]}`,
        project: `${segs[1]}/${segs[2]}`,
      };
  }
  if (/(^|\.)github\.com$/.test(host))
    return {
      provider: "github",
      apiBase: "https://api.github.com",
      webBase: `https://${host}`,
      project: path,
    };
  if (/github/.test(host))
    // GitHub Enterprise Server: API lives under /api/v3 on the instance host.
    return {
      provider: "github",
      apiBase: `https://${host}/api/v3`,
      webBase: `https://${host}`,
      project: path,
    };
  return {
    provider: "gitlab",
    apiBase: `https://${host}/api/v4`,
    webBase: `https://${host}`,
    project: path,
  };
}
