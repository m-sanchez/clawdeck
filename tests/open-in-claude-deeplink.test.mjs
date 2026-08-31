// @ts-check
/**
 * TASK 3: "Open in Claude" must OPEN Claude with the prompt PREFILLED but NOT
 * submitted. buildClaudeDeepLink builds a claude-cli://open URL (the documented
 * mechanism for an unsent prefilled prompt), it URL-encodes the cwd and prompt,
 * caps the prompt to the deep-link limit with a truncation flag, and returns a
 * plain URL string: nothing is spawned or auto-executed. The browser opens the
 * URL and keeps Copy prompt as the reliable, always-available fallback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeDeepLink,
  MAX_DEEPLINK_PROMPT_CHARS,
} from "../ui/lib/open-in-claude.mjs";

test("builds a claude-cli://open deep link with encoded cwd and prompt", () => {
  const r = buildClaudeDeepLink({ cwd: "/repo/app", prompt: "fix the tests" });
  assert.ok(r.url.startsWith("claude-cli://open?"));
  assert.ok(r.url.includes("cwd=" + encodeURIComponent("/repo/app")));
  assert.ok(r.url.includes("q=" + encodeURIComponent("fix the tests")));
  assert.equal(r.truncated, false);
});

test("cwd with spaces + Unicode is percent-encoded and round-trips exactly", () => {
  const cwd = "/Users/mé/My Projects/sample-app";
  const r = buildClaudeDeepLink({ cwd, prompt: "x" });
  assert.equal(new URL(r.url).searchParams.get("cwd"), cwd);
  assert.ok(!/ /.test(r.url), "no raw spaces in the URL");
});

test("reserved URL characters in the prompt are encoded, not literal", () => {
  const prompt = "a & b = c ? d # e / f + g";
  const r = buildClaudeDeepLink({ cwd: "/r", prompt });
  assert.equal(new URL(r.url).searchParams.get("q"), prompt);
  const query = r.url.split("?")[1];
  assert.equal(
    (query.match(/&/g) || []).length,
    1,
    "the only unescaped & is the cwd/q separator",
  );
});

test("a multiline prompt encodes newlines as %0A", () => {
  const r = buildClaudeDeepLink({ cwd: "/r", prompt: "line one\nline two" });
  assert.ok(r.url.includes("%0A"), "newline -> %0A");
  assert.equal(new URL(r.url).searchParams.get("q"), "line one\nline two");
});

test("prompt at the cap is not truncated; over the cap sets truncated + slices", () => {
  const atCap = "x".repeat(MAX_DEEPLINK_PROMPT_CHARS);
  const r1 = buildClaudeDeepLink({ cwd: "/r", prompt: atCap });
  assert.equal(r1.truncated, false);
  assert.equal(r1.promptChars, MAX_DEEPLINK_PROMPT_CHARS);
  const over = "y".repeat(MAX_DEEPLINK_PROMPT_CHARS + 2000);
  const r2 = buildClaudeDeepLink({ cwd: "/r", prompt: over });
  assert.equal(
    r2.truncated,
    true,
    "over the cap -> truncated flag drives the UI fallback",
  );
  assert.equal(r2.promptChars, MAX_DEEPLINK_PROMPT_CHARS);
  assert.equal(
    new URL(r2.url).searchParams.get("q").length,
    MAX_DEEPLINK_PROMPT_CHARS,
  );
});

test("no prompt -> a bare open link with just the cwd (nothing submitted)", () => {
  const r = buildClaudeDeepLink({ cwd: "/r", prompt: "" });
  assert.equal(r.url, "claude-cli://open?cwd=" + encodeURIComponent("/r"));
  assert.ok(!r.url.includes("q="));
});

test("returns a plain URL string, never a shell command or argv to execute", () => {
  const r = buildClaudeDeepLink({
    cwd: "/r",
    prompt: "do $(rm -rf /) && echo `whoami`",
  });
  assert.equal(typeof r.url, "string");
  assert.ok(r.url.startsWith("claude-cli://open?"));
  // No bin/args: the metacharacters are inert, percent-encoded inside q.
  assert.equal(/** @type {any} */ (r).bin, undefined);
  assert.equal(/** @type {any} */ (r).args, undefined);
  assert.equal(
    new URL(r.url).searchParams.get("q"),
    "do $(rm -rf /) && echo `whoami`",
  );
});

test("ASCII exactly at the cap is not truncated", () => {
  const atCap = "a".repeat(MAX_DEEPLINK_PROMPT_CHARS);
  const r = buildClaudeDeepLink({ cwd: "/r", prompt: atCap });
  assert.equal(r.truncated, false);
  assert.equal(r.promptChars, MAX_DEEPLINK_PROMPT_CHARS);
  assert.equal(new URL(r.url).searchParams.get("q"), atCap);
});

test("an emoji crossing the boundary never yields a lone surrogate (no URIError)", () => {
  // 4999 'x' + a 2-unit emoji = 5001 code units; a naive slice(0,5000) would keep
  // the emoji's high surrogate alone and make encodeURIComponent throw.
  const prompt = "x".repeat(MAX_DEEPLINK_PROMPT_CHARS - 1) + "😀";
  let r;
  assert.doesNotThrow(() => {
    r = buildClaudeDeepLink({ cwd: "/r", prompt });
  }, "truncation must not split a surrogate pair");
  assert.equal(r.truncated, true);
  const q = new URL(r.url).searchParams.get("q");
  assert.equal(
    q,
    "x".repeat(MAX_DEEPLINK_PROMPT_CHARS - 1),
    "the astral char is dropped whole",
  );
  assert.ok(q.length <= MAX_DEEPLINK_PROMPT_CHARS);
});

test("many astral characters truncate safely to complete code points", () => {
  const prompt = "😀".repeat(4000); // 8000 code units, over the cap
  let r;
  assert.doesNotThrow(() => {
    r = buildClaudeDeepLink({ cwd: "/r", prompt });
  });
  assert.equal(r.truncated, true);
  assert.ok(r.promptChars <= MAX_DEEPLINK_PROMPT_CHARS);
  const q = new URL(r.url).searchParams.get("q");
  assert.equal(
    [...q].every((ch) => ch === "😀"),
    true,
    "decodes to complete emoji only, no lone surrogate",
  );
});

test("combining characters at the boundary do not throw", () => {
  const prompt = "é".repeat(MAX_DEEPLINK_PROMPT_CHARS); // e + combining acute
  let r;
  assert.doesNotThrow(() => {
    r = buildClaudeDeepLink({ cwd: "/r", prompt });
  });
  assert.equal(r.truncated, true);
  assert.ok(
    new URL(r.url).searchParams.get("q").length <= MAX_DEEPLINK_PROMPT_CHARS,
  );
});

test("a multiline prompt past the cap still truncates without throwing", () => {
  const prompt = ("line\n".repeat(2000) + "😀".repeat(500)).slice(0);
  let r;
  assert.doesNotThrow(() => {
    r = buildClaudeDeepLink({ cwd: "/r", prompt });
  });
  assert.ok(r.url.includes("%0A"), "newlines still encode as %0A");
});
