// @ts-check
/**
 * The sandbox every Claude-backed panel feature shares: isolation arguments,
 * CLI resolution, a minimized child env, and a child runner that never rejects.
 *
 * One implementation on purpose - a copied fail-closed boundary is a boundary
 * that drifts. Callers add their own guards (secret scan, in-flight registry,
 * sterile cwd) around it; nothing here reads the filesystem or a token.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Isolation arguments for a Claude child. The privacy claim rests on these plus
 * a sterile cwd and the minimized env; the pre-wiring probe verifies the
 * PROPERTY (no instructions visible, no tools callable) on the installed CLI.
 */
export const ASK_ARGS = [
  "-p",
  "--output-format",
  "text",
  "--max-turns",
  "1",
  "--setting-sources",
  "",
  "--disallowedTools",
  "*",
  "--strict-mcp-config",
];

/**
 * Windows-safe resolution of the claude CLI: absolute .exe, else shell string.
 *
 * The isolation flags reach the child by argv in the first case and inside the
 * command string in the second, so a caller must check the effective
 * invocation, not one branch of it. `seams` exists so both branches can be
 * exercised on any machine.
 * @param {{existsSync?: Function, platform?: string, path?: string, home?: string}} [seams]
 */
export function resolveClaudeInvocation(seams = {}) {
  const exists = seams.existsSync || existsSync;
  const platform = seams.platform || process.platform;
  const pathVar = seams.path ?? process.env.PATH ?? "";
  const home = seams.home || homedir();

  const exe = join(home, ".local", "bin", "claude.exe");
  if (exists(exe)) return { file: exe, argv: ASK_ARGS, shell: false };
  if (platform === "win32") {
    for (const dir of String(pathVar).split(";")) {
      if (!dir) continue;
      const cand = join(dir, "claude.exe");
      try {
        if (exists(cand)) return { file: cand, argv: ASK_ARGS, shell: false };
      } catch {
        /* skip unreadable PATH entry */
      }
    }
    // npm's claude.cmd needs a shell; the command is a CONSTANT string (zero
    // interpolation) and the payload travels only on stdin.
    return { file: "claude " + ASK_ARGS.join(" "), argv: [], shell: true };
  }
  return { file: "claude", argv: ASK_ARGS, shell: false };
}

/**
 * Allowlisted child env: OS basics, plus the CLI's own credential.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` is the one credential-shaped variable that passes,
 * and only because it is the child's own: `claude setup-token` installs auth
 * that way, and on a machine using it the CLI cannot start without it. The
 * usual auth path is the credential file, reached through HOME/USERPROFILE, so
 * this is a fallback rather than the norm.
 *
 * Everything else stays out - forge tokens, API keys, and any other CLAUDE_*
 * variable that could steer the child's behaviour rather than authenticate it.
 */
export function askChildEnv() {
  const keep = [
    "PATH",
    "SYSTEMROOT",
    "COMSPEC",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "USERNAME",
    "LANG",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  const env = {};
  for (const k of keep) if (process.env[k] != null) env[k] = process.env[k];
  return env;
}

/**
 * Run a child process to completion, capturing stdout/stderr. Async (never
 * blocks the event loop) and never rejects; failures surface as a non-zero code.
 * @param {string} file @param {string[]} argv
 * `onChild` hands the live handle to the caller so a cancel can actually kill
 * it; without that, an aborted client fetch would leave the child running.
 * @param {{ cwd?: string, input?: string, timeoutMs?: number, shell?: boolean,
 *           env?: Record<string,string>, spawn?: Function,
 *           onChild?: (child: any) => void }} [opts]
 */
export function runChild(file, argv, opts = {}) {
  const { cwd, input, timeoutMs = 45000 } = opts;
  return new Promise((resolvePromise) => {
    const launch = opts.spawn || nodeSpawn;
    const child = launch(file, argv, {
      cwd,
      windowsHide: true,
      shell: opts.shell === true,
      ...(opts.env ? { env: opts.env } : {}),
    });
    opts.onChild?.(child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: String(e?.message || e) });
    });
    child.stdin.end(input ?? "");
  });
}
