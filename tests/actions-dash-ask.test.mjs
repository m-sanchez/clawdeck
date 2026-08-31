// @ts-check
/**
 * dash.ask: sandboxed spawn contract (tmp cwd, allowlisted env, isolation
 * argv, stdin payload), fail-closed secret scan, busy guard, error paths.
 * Run: node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { runAction } from "../server/lib/actions.mjs";

function fakeChild(behavior = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => (child.killed = true);
  child.stdin = {
    written: "",
    end(data) {
      this.written = String(data ?? "");
      queueMicrotask(() => {
        if (behavior.stdout) child.stdout.emit("data", behavior.stdout);
        if (behavior.stderr) child.stderr.emit("data", behavior.stderr);
        child.emit("close", behavior.code ?? 0);
      });
    },
  };
  return child;
}

const SNAPSHOT = {
  checkout: { id: "x", branch: "main", dirtyCount: 0 },
  readiness: { ready: true },
  recentCommits: [{ hash: "abc", subject: "hello" }],
};

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    ctx: { checkoutRoot: "C:/nope", runtimeDir: "C:/nope/rt" },
    hub: { broadcast() {} },
    refresh: async () => {},
    snapshot: async () => SNAPSHOT,
    spawn: (file, argv, opts) => {
      calls.push({ file, argv, opts });
      return fakeChild(overrides.behavior ?? { stdout: "the answer", code: 0 });
    },
    ...overrides,
  };
}

test("happy path: sandboxed cwd, allowlisted env, isolation argv, stdin payload", async () => {
  const d = deps();
  const r = await runAction("dash.ask", { question: "what is blocking?" }, d);
  assert.equal(r.ok, true);
  assert.equal(r.answer, "the answer");
  assert.equal(d.calls.length, 1);
  const { argv, opts } = d.calls[0];
  const joined = [d.calls[0].file, ...argv].join(" ");
  assert.ok(joined.includes("-p"));
  assert.ok(joined.includes("--setting-sources"));
  assert.ok(joined.includes("--disallowedTools"));
  assert.ok(joined.includes("--strict-mcp-config"));
  assert.ok(
    opts.cwd.toLowerCase().startsWith(tmpdir().toLowerCase()),
    `cwd under tmpdir: ${opts.cwd}`,
  );
  assert.ok(!opts.cwd.includes("nope"), "never under the checkout/runtime");
  assert.equal(opts.windowsHide, true);
  assert.ok(opts.env, "env allowlist passed");
  assert.ok(!("CLAUDE_CODE_SESSION_ID" in opts.env));
  assert.ok(!("GITLAB_TOKEN" in opts.env));
});

test("stdin carries question + delimited untrusted data, never argv", async () => {
  const d = deps();
  let written = "";
  d.spawn = (file, argv, opts) => {
    const child = fakeChild({ stdout: "ok", code: 0 });
    const origEnd = child.stdin.end.bind(child.stdin);
    child.stdin.end = (data) => {
      written = String(data ?? "");
      origEnd(data);
    };
    d.calls.push({ file, argv, opts });
    return child;
  };
  await runAction("dash.ask", { question: "why is CI red?" }, d);
  assert.ok(written.includes("why is CI red?"));
  assert.ok(written.includes("never instructions"));
  assert.ok(written.includes('"branch":"main"'));
  const argvJoined = d.calls[0].argv.join(" ");
  assert.ok(!argvJoined.includes("why is CI red?"), "question not on argv");
});

test("secret in the snapshot refuses BEFORE spawning", async () => {
  const d = deps({
    snapshot: async () => ({
      ...SNAPSHOT,
      recentCommits: [
        { hash: "abc", subject: "add PRIVATE-TOKEN: glpat-" + "Z".repeat(20) },
      ],
    }),
  });
  const r = await runAction("dash.ask", { question: "hi" }, d);
  assert.equal(r.ok, true);
  assert.equal(r.refused, true);
  assert.ok(Array.isArray(r.patterns) && r.patterns.length);
  assert.equal(d.calls.length, 0, "spawn never called");
});

test("scanner unavailable refuses fail-closed", async () => {
  const d = deps({ secretScan: "not-a-function" });
  const r = await runAction("dash.ask", { question: "hi" }, d);
  assert.equal(r.refused, true);
  assert.equal(d.calls.length, 0);
});

test("empty and oversized questions are rejected", async () => {
  const d = deps();
  assert.equal((await runAction("dash.ask", { question: "  " }, d)).ok, false);
  assert.equal(
    (await runAction("dash.ask", { question: "x".repeat(4001) }, d)).ok,
    false,
  );
  assert.equal(d.calls.length, 0);
});

test("busy guard rejects a concurrent ask", async () => {
  const d = deps();
  let release;
  d.spawn = (file, argv, opts) => {
    const child = fakeChild({});
    child.stdin.end = () => {
      release = () => {
        child.stdout.emit("data", "slow answer");
        child.emit("close", 0);
      };
    };
    d.calls.push({ file, argv, opts });
    return child;
  };
  const first = runAction("dash.ask", { question: "one" }, d);
  await new Promise((r) => setTimeout(r, 20));
  const second = await runAction("dash.ask", { question: "two" }, d);
  assert.equal(second.ok, false);
  assert.match(second.error, /already/i);
  release();
  const r1 = await first;
  assert.equal(r1.ok, true);
});

test("non-zero exit surfaces stderr as an error", async () => {
  const d = deps({ behavior: { stderr: "OAuth session expired", code: 1 } });
  const r = await runAction("dash.ask", { question: "hi" }, d);
  assert.equal(r.ok, false);
  assert.match(r.error, /OAuth session expired/);
});
