// @ts-check
/**
 * Forge detection: which git hosting provider the observed checkout talks to,
 * derived from `git remote get-url origin` with env overrides. Tokens are read
 * server-side only (env or the checkout's settings.local.json) and never reach
 * the browser.
 *
 * v0.1 providers: github, gitlab (self-hosted included). Unknown hosts default
 * to gitlab, whose API shape most self-hosted forges follow.
 */
import { execFile } from "node:child_process";
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

/** Provider token for this checkout. Never logged or returned to the client. */
export function forgeToken(checkoutRoot, provider) {
  return settingsEnv(
    checkoutRoot,
    provider === "github" ? "GITHUB_TOKEN" : "GITLAB_TOKEN",
  );
}

/**
 * Resolve the forge for a checkout: env overrides first, then the origin remote.
 * @returns {Promise<{ provider: 'github'|'gitlab', apiBase: string, webBase: string, project: string } | null>}
 */
export async function detectForge(checkoutRoot) {
  const forced = (process.env.FORGE_PROVIDER || "").toLowerCase();

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
