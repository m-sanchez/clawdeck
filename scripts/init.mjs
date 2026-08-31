#!/usr/bin/env node
// @ts-check
/**
 * Install Clawdeck's integration files into a target Claude Code project:
 *
 *   node scripts/init.mjs --target <dir> [--write-settings] [--statusline] [--force]
 *
 * - Copies the event-emitter hook (+ its lib) and slash-command templates into
 *   the target's .claude/, marker-stamped so re-runs update only our files.
 * - Prints the hook registrations to paste into .claude/settings.json (and
 *   writes them to .claude/panel-hooks.generated.json). `--write-settings`
 *   opts in to a parse-merge that appends only missing emit-event entries,
 *   with a settings.json.bak backup. It never touches other hooks.
 * - `--statusline` also installs the statusline bridge (feeds the Cost view)
 *   and, with --write-settings, sets statusLine only when currently unset.
 */
import { existsSync, copyFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PANEL_ROOT, resolvePanelContext } from "./lib/context.mjs";

const MARKER = "generated-by: clawdeck";
const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "InstructionsLoaded",
  "PreCompact",
  "PostCompact",
  "Notification",
  "PermissionDenied",
  "CwdChanged",
];
const HOOK_COMMAND = "node .claude/hooks/emit-event.cjs";
const STATUSLINE_COMMAND = "node .claude/hooks/statusline-bridge.cjs";

function parseArgs(argv) {
  const args = {
    target: null,
    writeSettings: false,
    statusline: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--target" && argv[i + 1]) args.target = argv[(i += 1)];
    else if (a.startsWith("--target="))
      args.target = a.slice("--target=".length);
    else if (a === "--write-settings") args.writeSettings = true;
    else if (a === "--statusline") args.statusline = true;
    else if (a === "--force") args.force = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const context = resolvePanelContext(
  args.target ? resolve(args.target) : undefined,
);
const target = context.checkoutRoot;
if (resolve(target) === resolve(PANEL_ROOT))
  throw new Error(
    "Refusing to install into the Clawdeck repository itself. Pass --target <your project>.",
  );

let version = "0.0.0";
try {
  version = JSON.parse(
    await readFile(join(PANEL_ROOT, "package.json"), "utf8"),
  ).version;
} catch {
  /* keep placeholder */
}

/**
 * Copy one file with a marker header. Existing files are overwritten only when
 * they carry our marker (a previous install) or --force is passed.
 */
async function installFile(sourceRel, targetAbs, commentPrefix) {
  const body = await readFile(join(PANEL_ROOT, sourceRel), "utf8");
  const header = `${commentPrefix} ${MARKER} v${version}\n`;
  // A shebang must stay on line 1; slot the marker in after it.
  const nl = body.indexOf("\n") + 1;
  const next = body.startsWith("#!")
    ? body.slice(0, nl) + header + body.slice(nl)
    : header + body;
  if (existsSync(targetAbs)) {
    const current = await readFile(targetAbs, "utf8");
    if (current === next) return "unchanged";
    if (!current.includes(MARKER) && !args.force) return "skipped (unmanaged)";
  }
  await writeFile(targetAbs, next, "utf8");
  return "installed";
}

// 1. Hooks: entrypoints at .claude/hooks/ + their lib/, preserving relative requires.
const hooksDir = join(target, ".claude", "hooks");
await mkdir(join(hooksDir, "lib"), { recursive: true });
const hookFiles = [
  ["hooks/emit-event.cjs", join(hooksDir, "emit-event.cjs")],
  ["hooks/lib/event-spool.cjs", join(hooksDir, "lib", "event-spool.cjs")],
  [
    "hooks/lib/event-normalize.cjs",
    join(hooksDir, "lib", "event-normalize.cjs"),
  ],
];
if (args.statusline)
  hookFiles.push([
    "hooks/statusline-bridge.cjs",
    join(hooksDir, "statusline-bridge.cjs"),
  ]);
for (const [src, dst] of hookFiles) {
  const state = await installFile(src, dst, "//");
  console.log(`${state}: ${dst}`);
}

// 2. Slash commands, with the machine-specific panel path substituted in.
const commandsDir = join(target, ".claude", "commands");
await mkdir(commandsDir, { recursive: true });
for (const name of [
  "panel.md",
  "panel-full.md",
  "panel-status.md",
  "panel-stop.md",
]) {
  const template = (
    await readFile(join(PANEL_ROOT, "command-templates", name), "utf8")
  ).replaceAll("{{PANEL_ROOT}}", PANEL_ROOT.replaceAll("\\", "/"));
  const dst = join(commandsDir, name);
  const header = `<!-- ${MARKER} v${version} -->\n`;
  const next = header + template;
  if (existsSync(dst)) {
    const current = await readFile(dst, "utf8");
    if (current !== next && (current.includes(MARKER) || args.force)) {
      await writeFile(dst, next, "utf8");
      console.log(`updated: ${dst}`);
    } else if (!current.includes(MARKER)) {
      console.log(`skipped (unmanaged): ${dst}`);
    }
  } else {
    await writeFile(dst, next, "utf8");
    console.log(`installed: ${dst}`);
  }
}

// 3. .gitignore: keep the runtime dir out of the target's history.
const gitignorePath = join(target, ".gitignore");
const runtimeIgnore = ".claude/.runtime/";
let gitignore = existsSync(gitignorePath)
  ? await readFile(gitignorePath, "utf8")
  : "";
if (!gitignore.split(/\r?\n/).includes(runtimeIgnore)) {
  if (gitignore && !gitignore.endsWith("\n")) gitignore += "\n";
  gitignore += `\n# Clawdeck runtime\n${runtimeIgnore}\n`;
  await writeFile(gitignorePath, gitignore, "utf8");
  console.log(`updated: ${gitignorePath}`);
}

// 4. Hook registrations.
const registration = {};
for (const event of HOOK_EVENTS)
  registration[event] = [
    { hooks: [{ type: "command", command: HOOK_COMMAND }] },
  ];
const generatedPath = join(target, ".claude", "panel-hooks.generated.json");
await writeFile(
  generatedPath,
  JSON.stringify({ hooks: registration }, null, 2) + "\n",
  "utf8",
);
console.log(`wrote: ${generatedPath}`);

const settingsPath = join(target, ".claude", "settings.json");
if (args.writeSettings) {
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf8"));
    } catch (e) {
      throw new Error(
        `Cannot parse ${settingsPath}: ${String((e && e.message) || e)}. Fix it first, or paste the hooks manually.`,
      );
    }
    copyFileSync(settingsPath, settingsPath + ".bak");
  }
  settings.hooks = settings.hooks || {};
  let added = 0;
  for (const event of HOOK_EVENTS) {
    const arr = Array.isArray(settings.hooks[event])
      ? settings.hooks[event]
      : (settings.hooks[event] = []);
    const present = arr.some((entry) =>
      (entry?.hooks || []).some((h) =>
        String(h?.command || "").includes("emit-event.cjs"),
      ),
    );
    if (!present) {
      arr.push({ hooks: [{ type: "command", command: HOOK_COMMAND }] });
      added += 1;
    }
  }
  if (args.statusline && !settings.statusLine) {
    settings.statusLine = { type: "command", command: STATUSLINE_COMMAND };
    console.log("set statusLine to the Clawdeck bridge");
  }
  await writeFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
    "utf8",
  );
  console.log(
    `merged ${added} hook registration(s) into ${settingsPath} (backup: settings.json.bak)`,
  );
} else {
  console.log(
    `\nAdd the hook registrations to ${settingsPath} (or re-run with --write-settings):`,
  );
  console.log(`  see ${generatedPath}`);
  if (args.statusline)
    console.log(
      `  and set "statusLine": { "type": "command", "command": "${STATUSLINE_COMMAND}" }`,
    );
}

console.log("\nClawdeck install complete. Next steps:");
console.log("  1. Restart your Claude Code session (hooks load at start).");
console.log(
  `  2. Run the panel: node "${PANEL_ROOT.replaceAll("\\", "/")}/scripts/panel-run.mjs" --checkout "${target.replaceAll("\\", "/")}"`,
);
console.log("     (or /panel from inside Claude Code)");
