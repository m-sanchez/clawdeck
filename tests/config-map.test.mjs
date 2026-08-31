// @ts-check
/** Config map: discovery of declared config + usage overlay correlation. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverConfig,
  overlayUsage,
} from "../server/adapters/config-map.mjs";

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "clawdeck-cfg-"));
  const dot = join(root, ".claude");
  mkdirSync(join(dot, "rules"), { recursive: true });
  mkdirSync(join(dot, "commands"), { recursive: true });
  mkdirSync(join(dot, "agents"), { recursive: true });
  mkdirSync(join(dot, "skills", "review-pack"), { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), "# rules\n");
  writeFileSync(join(dot, "rules", "style.md"), "# always\n");
  writeFileSync(
    join(dot, "rules", "scoped.md"),
    "---\npaths:\n  - src/**\n---\nbody\n",
  );
  writeFileSync(join(dot, "commands", "deploy.md"), "run deploy\n");
  writeFileSync(join(dot, "agents", "reviewer.md"), "reviews\n");
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { figma: {}, browser: {} } }),
  );
  writeFileSync(
    join(dot, "settings.json"),
    JSON.stringify({
      mcpServers: { extra: {} },
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "node .claude/hooks/emit-event.cjs" },
            ],
          },
        ],
      },
    }),
  );
});
after(() => rmSync(root, { recursive: true, force: true }));

test("discovery finds rules (with scoping), commands, skills, agents, MCP, hooks", () => {
  const d = discoverConfig(root);
  assert.equal(d.hasClaudeMd, true);
  assert.equal(d.hasAgentsMd, false);
  assert.deepEqual(
    d.rules.sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "scoped", scoped: true },
      { name: "style", scoped: false },
    ],
  );
  assert.deepEqual(d.commands, ["deploy"]);
  assert.deepEqual(d.skills, ["review-pack"]);
  assert.deepEqual(d.agents, ["reviewer"]);
  assert.deepEqual(d.mcpServers.sort(), ["browser", "extra", "figma"]);
  assert.deepEqual(d.hooks, [{ event: "Stop", files: ["emit-event.cjs"] }]);
});

test("overlay marks used vs dead and surfaces undeclared calls", () => {
  const d = discoverConfig(root);
  const merged = overlayUsage(d, {
    servers: [
      { server: "browser", calls: 12 },
      { server: "plugin_devtools", calls: 7 },
    ],
    skills: [{ skill: "review-pack", count: 3 }],
    agents: { reviewer: 2, Explore: 5 },
    commands: { deploy: 1, autoloop: 4 },
  });
  assert.deepEqual(
    merged.mcpServers.find((m) => m.name === "browser"),
    {
      name: "browser",
      used: 12,
    },
  );
  assert.equal(merged.mcpServers.find((m) => m.name === "figma").used, 0);
  assert.equal(merged.skills[0].used, 3);
  assert.equal(merged.commands[0].used, 1);
  assert.equal(merged.agents[0].used, 2);
  assert.deepEqual(merged.observedUnknown.agents, ["Explore"]);
  assert.deepEqual(merged.observedUnknown.commands, ["autoloop"]);
  assert.deepEqual(merged.observedUnknown.servers, ["plugin_devtools"]);
});

test("empty checkout degrades to empty lists, never throws", () => {
  const empty = mkdtempSync(join(tmpdir(), "clawdeck-cfg-empty-"));
  try {
    const d = discoverConfig(empty);
    assert.deepEqual(d.rules, []);
    assert.deepEqual(d.mcpServers, []);
    const merged = overlayUsage(d, {});
    assert.deepEqual(merged.commands, []);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
