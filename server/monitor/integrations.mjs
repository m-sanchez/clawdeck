import { readFile, writeFile, mkdir, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { atomicJson } from "./collector.mjs";

const events = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "SessionEnd",
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;

export class Integrations {
  constructor({ dataDir, runtime, captureFile, homes = {} }) {
    Object.assign(this, { dataDir, runtime, captureFile });
    this.homes = {
      codex: process.env.CODEX_HOME || join(homedir(), ".codex"),
      claude: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      ...homes,
    };
    this.previews = new Map();
  }
  command(provider) {
    const script = `$env:ELECTRON_RUN_AS_NODE='1'; & ${psQuote(this.runtime)} ${psQuote(join(this.dataDir, "hooks", "ocelin-capture.cjs"))} ${psQuote(provider)} ${psQuote(this.dataDir)}; exit 0`;
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  async preview(provider, remove = false) {
    if (!["codex", "claude"].includes(provider))
      throw new Error("Unknown integration");
    const file = join(
      this.homes[provider],
      provider === "codex" ? "hooks.json" : "settings.json",
    );
    let raw = "{}";
    try {
      if ((await stat(file)).size > 1024 * 1024)
        throw new Error("Configuration is too large");
      raw = await readFile(file, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const before = JSON.parse(raw);
    if (!before || typeof before !== "object" || Array.isArray(before))
      throw new Error("Expected a JSON settings object");
    const after = structuredClone(before);
    after.hooks ??= {};
    const command = this.command(provider);
    let owned = [];
    try {
      owned = JSON.parse(
        await readFile(
          join(this.dataDir, "hooks", `${provider}-ownership.json`),
          "utf8",
        ),
      );
    } catch {}
    const ownCommands = new Set([...owned, command]);
    for (const [event, groups] of Object.entries(after.hooks)) {
      if (!Array.isArray(groups))
        throw new Error(`Invalid hook groups for ${event}`);
      after.hooks[event] = groups
        .map((group) => ({
          ...group,
          hooks: (group.hooks || []).filter((h) => !ownCommands.has(h.command)),
        }))
        .filter((group) => group.hooks.length);
      if (!after.hooks[event].length) delete after.hooks[event];
    }
    if (!remove)
      for (const event of [
        ...events,
        ...(provider === "codex"
          ? ["Interrupt"]
          : ["Notification", "StopFailure"]),
      ]) {
        (after.hooks[event] ??= []).push({
          hooks: [{ type: "command", command, timeout: 3 }],
        });
      }
    if (!Object.keys(after.hooks).length) delete after.hooks;
    const id = sha(`${file}:${raw}:${JSON.stringify(after)}`);
    this.previews.set(id, {
      provider,
      file,
      raw,
      after,
      remove,
      command,
      owned,
    });
    return {
      id,
      provider,
      file,
      remove,
      before: before.hooks || {},
      after: after.hooks || {},
      note:
        provider === "codex"
          ? "After applying, review and trust these hooks in Codex /hooks. Restart existing sessions if needed."
          : "Existing sessions may need to be restarted. Other hooks and settings are preserved.",
      handler:
        "Writes session ID, project path, event time and lifecycle state locally. No prompts, tool arguments or responses.",
    };
  }
  async apply(id) {
    const preview = this.previews.get(id);
    if (!preview) throw new Error("Preview the integration first");
    let current = "{}";
    try {
      current = await readFile(preview.file, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (current !== preview.raw)
      throw new Error("Settings changed; preview again before applying");
    await mkdir(join(this.dataDir, "hooks"), { recursive: true });
    await copyFile(
      this.captureFile,
      join(this.dataDir, "hooks", "ocelin-capture.cjs"),
    );
    const backup = join(
      this.dataDir,
      "hooks",
      `${preview.provider}-${Date.now()}.backup.json`,
    );
    await writeFile(backup, preview.raw, { mode: 0o600 });
    await atomicJson(
      join(this.dataDir, "hooks", `${preview.provider}-ownership.json`),
      [...new Set([...preview.owned, preview.command])],
    );
    await atomicJson(preview.file, preview.after);
    this.previews.delete(id);
    return { applied: true, backup, removed: preview.remove };
  }
}
