// @ts-check
/**
 * Config map with a usage overlay: everything the observed checkout's Claude
 * setup declares (rules, slash commands, skills, agents, MCP servers, hooks)
 * correlated with what recent transcripts actually invoked - so dead config
 * is visibly dead instead of silently loaded.
 *
 * Discovery reads only the checkout's own config files; usage counts come
 * from the (cached, bounded) transcript scan. A declared item with zero
 * observed calls is reported `used: 0`, never hidden.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

function listMd(dir) {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".md"))
      .map((n) => n.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

/** Does a rules file declare `paths:` frontmatter (path-scoped load)? */
function ruleScoped(path) {
  try {
    const head = readFileSync(path, "utf8").slice(0, 500);
    return /^---[\s\S]*?\bpaths\s*:/m.test(head);
  } catch {
    return false;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Declared config across the standard Claude Code locations. Exported for tests. */
export function discoverConfig(checkoutRoot) {
  const dot = join(checkoutRoot, ".claude");

  const rules = listMd(join(dot, "rules")).map((name) => ({
    name,
    scoped: ruleScoped(join(dot, "rules", `${name}.md`)),
  }));
  const commands = listMd(join(dot, "commands"));
  const agents = listMd(join(dot, "agents"));

  // Skills live one folder deep: .claude/skills/<name>/SKILL.md
  let skills = [];
  try {
    skills = readdirSync(join(dot, "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    /* none */
  }

  const mcpServers = new Set();
  const mcpJson = readJson(join(checkoutRoot, ".mcp.json"));
  for (const name of Object.keys(mcpJson?.mcpServers || {}))
    mcpServers.add(name);
  const settings = readJson(join(dot, "settings.json"));
  for (const name of Object.keys(settings?.mcpServers || {}))
    mcpServers.add(name);

  const hooks = [];
  for (const [event, entries] of Object.entries(settings?.hooks || {})) {
    const files = new Set();
    for (const entry of Array.isArray(entries) ? entries : [])
      for (const h of entry?.hooks || [])
        if (h?.command)
          files.add(basename(String(h.command).split(/\s+/).pop() || ""));
    hooks.push({ event, files: [...files] });
  }

  return {
    hasClaudeMd: existsSync(join(checkoutRoot, "CLAUDE.md")),
    hasAgentsMd: existsSync(join(checkoutRoot, "AGENTS.md")),
    rules,
    commands,
    skills,
    agents,
    mcpServers: [...mcpServers],
    hooks,
  };
}

/**
 * Merge declared config with observed usage (from the transcript scan).
 * Exported for tests; pure.
 * @param {ReturnType<typeof discoverConfig>} declared
 * @param {{ servers?: Array<{server: string, calls: number}>, skills?: Array<{skill: string, count: number}>, agents?: Record<string, number>, commands?: Record<string, number> }} usage
 */
export function overlayUsage(declared, usage) {
  const serverCalls = new Map(
    (usage.servers || []).map((s) => [s.server, s.calls]),
  );
  const skillCalls = new Map(
    (usage.skills || []).map((s) => [s.skill, s.count]),
  );
  const agentCalls = usage.agents || {};
  const commandCalls = usage.commands || {};

  // A slash command and a skill share a namespace from the transcript's view:
  // "/foo" may invoke either, so both sides read from both counters.
  const invoked = (name) =>
    (skillCalls.get(name) || 0) + (commandCalls[name] || 0);

  return {
    claudeMd: declared.hasClaudeMd,
    agentsMd: declared.hasAgentsMd,
    rules: declared.rules.map((r) => ({ ...r })),
    commands: declared.commands.map((name) => ({ name, used: invoked(name) })),
    skills: declared.skills.map((name) => ({ name, used: invoked(name) })),
    agents: declared.agents.map((name) => ({
      name,
      used: agentCalls[name] || 0,
    })),
    mcpServers: declared.mcpServers.map((name) => ({
      name,
      used: serverCalls.get(name) || 0,
    })),
    hooks: declared.hooks,
    observedUnknown: {
      // Called in transcripts but not declared here (global/user/plugin config).
      agents: Object.keys(agentCalls).filter(
        (a) => !declared.agents.includes(a),
      ),
      commands: Object.keys(commandCalls).filter(
        (c) => !declared.commands.includes(c) && !declared.skills.includes(c),
      ),
      servers: (usage.servers || [])
        .filter((sv) => !declared.mcpServers.includes(sv.server))
        .map((sv) => sv.server),
    },
  };
}
