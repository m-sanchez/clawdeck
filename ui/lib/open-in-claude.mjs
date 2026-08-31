// @ts-check
/**
 * Build a SAFE "Open in Claude" launch. The composed prompt is prefilled via the
 * claude-cli:// deep link (URL-encoded), NEVER placed on a shell command line and
 * NEVER auto-submitted: the deep link opens Claude in the target cwd with the
 * prompt in the input box, and the user reviews it and presses Enter. A positional
 * `claude "<prompt>"` argument, by contrast, submits immediately, the wrong
 * semantics, so it is not used. Pure (no DOM/Node), so the browser view and a
 * node test share one source of truth.
 */
const MODELS = new Set([
  "sonnet",
  "opus",
  "haiku",
  "fable",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
]);
const MODES = new Set(["plan", "acceptEdits", "default"]);

/**
 * The bare `claude` command (no prompt) shown as a manual fallback: a user can
 * run it in the target checkout and paste the copied prompt. No prompt on the
 * command line, so nothing is auto-submitted or injectable.
 * @param {{ model?: string, permissionMode?: string, background?: boolean }} [opts]
 * @returns {{ bin: string, args: string[], display: string }}
 */
export function buildClaudeCommand(opts = {}) {
  const mode = MODES.has(opts.permissionMode || "")
    ? opts.permissionMode
    : "plan";
  const args = ["--permission-mode", mode];
  if (opts.model && MODELS.has(opts.model)) args.push("--model", opts.model);
  if (opts.background) args.push("--bg");
  return { bin: "claude", args, display: `claude ${args.join(" ")}` };
}

/** Documented `claude-cli://` `q` (prompt) length cap for the deep link. */
export const MAX_DEEPLINK_PROMPT_CHARS = 5000;

/**
 * Truncate to at most `max` UTF-16 code units WITHOUT splitting a surrogate pair.
 * A lone surrogate makes encodeURIComponent throw ("URI malformed"), so if the
 * last kept unit is a high surrogate (its low half sits at index `max` and would
 * be dropped) step back one and drop the whole astral character. The result is
 * always <= max code units and always well-formed.
 */
function truncateCodeUnits(str, max) {
  if (str.length <= max) return str;
  let end = max;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return str.slice(0, end);
}

/**
 * Build a `claude-cli://open` deep link that opens Claude in `cwd` with `prompt`
 * PREFILLED but NOT submitted. The caller (browser) navigates to the URL; if the
 * OS has no claude-cli:// handler nothing opens and the UI must fall back to Copy
 * prompt, a browser cannot observe custom-scheme success, so the action must not
 * claim the session opened. encodeURIComponent escapes spaces, Unicode, reserved
 * URL characters, and newlines (-> %0A). Over the cap, the prompt is truncated
 * for the link and `truncated` is set so the UI can steer the user to Copy prompt.
 * @param {{ cwd?: string, prompt?: string }} [opts]
 * @returns {{ url: string, truncated: boolean, promptChars: number,
 *   cwd: string|null }}
 */
export function buildClaudeDeepLink(opts = {}) {
  const rawPrompt = String(opts.prompt ?? "");
  const truncated = rawPrompt.length > MAX_DEEPLINK_PROMPT_CHARS;
  const bounded = truncated
    ? truncateCodeUnits(rawPrompt, MAX_DEEPLINK_PROMPT_CHARS)
    : rawPrompt;
  const cwd =
    opts.cwd != null && String(opts.cwd).length > 0 ? String(opts.cwd) : null;
  const params = [];
  if (cwd) params.push("cwd=" + encodeURIComponent(cwd));
  if (bounded.length > 0) params.push("q=" + encodeURIComponent(bounded));
  const url =
    "claude-cli://open" + (params.length ? "?" + params.join("&") : "");
  return { url, truncated, promptChars: bounded.length, cwd };
}
