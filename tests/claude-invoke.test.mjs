// @ts-check
/**
 * The shared Claude sandbox. Its isolation flags reach the child by one of two
 * routes - argv for an absolute .exe, a constant command string for npm's
 * claude.cmd on Windows - and a caller that checks only one of them will pass
 * on one platform and fail on the other. So the property asserted here is the
 * effective invocation, on every platform.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_ARGS,
  askChildEnv,
  resolveClaudeInvocation,
} from "../server/lib/claude-invoke.mjs";

test("the isolation flags survive whichever resolution branch is taken", () => {
  const inv = resolveClaudeInvocation();
  const invocation = [inv.file, ...inv.argv].join(" ");
  for (const flag of ASK_ARGS)
    if (flag.startsWith("--"))
      assert.ok(
        invocation.includes(flag),
        `${flag} missing from ${invocation}`,
      );
  assert.equal(
    inv.shell === true ? inv.argv.length : 0,
    0,
    "the shell branch passes a constant string with no interpolated argv",
  );
});

test("both resolution branches carry the flags, on any machine", () => {
  const check = (inv) => {
    const invocation = [inv.file, ...inv.argv].join(" ");
    for (const flag of ASK_ARGS.filter((a) => a.startsWith("--")))
      assert.ok(
        invocation.includes(flag),
        `${flag} missing from ${invocation}`,
      );
  };

  // Absolute .exe: flags ride argv.
  const direct = resolveClaudeInvocation({
    existsSync: () => true,
    platform: "win32",
    home: "C:/home",
  });
  assert.equal(direct.shell, false);
  assert.ok(direct.argv.length > 0);
  check(direct);

  // npm's claude.cmd on Windows: nothing on PATH, so a constant shell string.
  // This is the branch CI runs, and the one an argv-only assertion misses.
  const shellFallback = resolveClaudeInvocation({
    existsSync: () => false,
    platform: "win32",
    path: "",
    home: "C:/home",
  });
  assert.equal(shellFallback.shell, true);
  assert.deepEqual(
    shellFallback.argv,
    [],
    "no interpolated argv in the shell form",
  );
  check(shellFallback);

  // POSIX: bare binary, flags on argv.
  const posix = resolveClaudeInvocation({
    existsSync: () => false,
    platform: "linux",
    home: "/home/x",
  });
  assert.equal(posix.file, "claude");
  check(posix);
});

test("the isolation set itself is fixed: no tools, no settings, no MCP", () => {
  const joined = ASK_ARGS.join(" ");
  assert.match(joined, /--disallowedTools \*/);
  assert.match(joined, /--strict-mcp-config/);
  assert.match(joined, /--setting-sources/);
  assert.match(joined, /--max-turns 1/);
  assert.match(joined, /-p/);
});

test("the child env carries only the CLI's own credential, nothing else", () => {
  const saved = { ...process.env };
  try {
    // Everything a leak would look like, set at once.
    process.env.GITHUB_TOKEN = "gh-secret";
    process.env.GITLAB_TOKEN = "gl-secret";
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    process.env.CLAUDE_CODE_SESSION_ID = "session-123";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "the-cli-credential";

    const env = askChildEnv();

    for (const key of ["GITHUB_TOKEN", "GITLAB_TOKEN", "ANTHROPIC_API_KEY"])
      assert.equal(key in env, false, `${key} must never reach a Claude child`);
    assert.equal(
      "CLAUDE_CODE_SESSION_ID" in env,
      false,
      "a CLAUDE_* variable that steers behaviour is not an auth necessity",
    );
    // The one carve-out: the child's own credential, which `claude setup-token`
    // installs and without which the CLI cannot authenticate at all.
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "the-cli-credential");
    // PATH has to be there or the CLI cannot be found at all.
    assert.ok("PATH" in env || "Path" in env);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("the credential is absent from the child env when the machine has none", () => {
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in askChildEnv(), false);
  } finally {
    if (saved !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
  }
});
