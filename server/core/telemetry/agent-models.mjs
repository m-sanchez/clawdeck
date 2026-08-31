// @ts-check
/**
 * Resolve the model each subagent TYPE is pinned to, from the agent definition
 * frontmatter (`.claude/agents/<type>.md` `model:` field). This is the
 * deterministic attribution source when a live event does not carry the
 * subagent's model: a reader pinned to a cheap model is NOT running on the
 * parent's model, and the panel must not claim otherwise. Built-in agent types
 * with no `.md` (e.g. Explore) have no pin and resolve to null (unknown).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Parse the `model:` value out of a YAML frontmatter block. */
function frontmatterModel(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find((l) => /^\s*model\s*:/.test(l));
  if (!line) return null;
  let val = line.replace(/^\s*model\s*:\s*/, "").trim();
  // Strip a trailing YAML `# comment` (an unquoted value ends at ` #`), else a
  // pin like `model: sonnet # avoid fable` would match /fable/ downstream.
  val = val.replace(/\s+#.*$/, "").trim();
  return val ? val.replace(/^["']|["']$/g, "") : null;
}

/**
 * @param {string} checkoutRoot
 * @returns {Record<string, string>} agentType -> pinned model id
 */
export function readAgentModelPins(checkoutRoot) {
  const dir = join(checkoutRoot, ".claude", "agents");
  /** @type {Record<string, string>} */
  const pins = {};
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return pins;
  }
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const model = frontmatterModel(text);
    if (model) pins[name.replace(/\.md$/, "")] = model;
  }
  return pins;
}
