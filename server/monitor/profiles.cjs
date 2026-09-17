const { createHash } = require("node:crypto");
const { homedir } = require("node:os");
const { join, normalize, isAbsolute, basename } = require("node:path");

const providers = ["codex", "claude"];
const pathKey = (value) =>
  process.platform === "win32"
    ? normalize(value).toLowerCase()
    : normalize(value);
function profileLabel(value, fallback) {
  return typeof value === "string"
    ? value
        .replace(/[\x00-\x1f\x7f]/g, "")
        .trim()
        .slice(0, 48) || fallback
    : fallback;
}
function accountProfiles(saved = [], env = process.env) {
  const defaults = providers.map((provider) => ({
    id: `${provider}-default`,
    provider,
    label: "Default",
    builtin: true,
    home:
      env[provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] ||
      join(homedir(), `.${provider}`),
  }));
  const seen = new Set(defaults.map((p) => `${p.provider}:${pathKey(p.home)}`));
  for (const item of Array.isArray(saved) ? saved.slice(0, 8) : []) {
    if (
      !providers.includes(item?.provider) ||
      typeof item.home !== "string" ||
      item.home.length > 4096 ||
      !isAbsolute(item.home) ||
      /^[/\\]{2}/.test(item.home) ||
      /[\x00-\x1f]/.test(item.home)
    )
      continue;
    const home = normalize(item.home),
      key = `${item.provider}:${pathKey(home)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    defaults.push({
      id: createHash("sha256").update(key).digest("hex").slice(0, 20),
      provider: item.provider,
      home,
      builtin: false,
      label: profileLabel(item.label, basename(home)),
    });
  }
  return defaults;
}
function profileSources(sources, saved = [], env = process.env) {
  const profiles = accountProfiles(saved, env);
  const result = Array.isArray(sources) ? [...sources] : [];
  for (const p of profiles) {
    if (p.builtin && Array.isArray(sources)) continue;
    const root = join(p.home, p.provider === "codex" ? "sessions" : "projects");
    if (
      !result.some(
        (s) => s.provider === p.provider && pathKey(s.root) === pathKey(root),
      )
    )
      result.push({ provider: p.provider, root });
  }
  return result;
}
function sessionProfiles(session, profiles) {
  const roots = Array.isArray(session.sourceRoots)
    ? session.sourceRoots.filter((root) => typeof root === "string")
    : [];
  return profiles
    .filter(
      (p) =>
        p.provider === session.provider &&
        roots.some((root) =>
          (p.provider === "codex"
            ? ["sessions", "archived_sessions"]
            : ["projects"]
          ).some((dir) => pathKey(root) === pathKey(join(p.home, dir))),
        ),
    )
    .map((p) => ({ id: p.id, label: p.label }));
}
module.exports = {
  accountProfiles,
  profileLabel,
  profileSources,
  sessionProfiles,
};
