// @ts-check
/**
 * Shared secret scanner for every export/share path (review-pack, panel-pack).
 * One source of truth for the patterns so the /review-pack command and the panel
 * export jobs cannot drift apart. Hits report location + pattern id only, never
 * the matched value, so a scan result is itself safe to log or surface.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * High-confidence secret shapes, matched case-insensitively (header names and
 * hex casing vary). `placeholderExempt` marks the PRIVATE-TOKEN rule, whose
 * documented `$VAR` placeholder is not a real secret.
 * @type {{id:string, re:RegExp, placeholderExempt?:boolean}[]}
 */
export const SECRET_PATTERNS = [
  { id: "private-key", re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  {
    id: "private-token",
    re: /PRIVATE-TOKEN\s*[:=]\s*\S+/,
    placeholderExempt: true,
  },
  { id: "aws-akia", re: /AKIA[0-9A-Z]{16}/ },
  { id: "github-token", re: /gh[pousr]_[A-Za-z0-9_]{30,}/ },
  // \b anchors sk- to a token boundary so ordinary words that merely contain
  // "sk" (risk-/task-/disk-/mask-) do not false-positive and refuse a legit pack.
  { id: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  // GitLab PAT family (personal/deploy/runner/CI/trigger/…): the bare TOKEN
  // SHAPE, so a leaked `glpat-…` in an env var, config or doc is caught without
  // a `PRIVATE-TOKEN` header. No name-based `GITLAB_TOKEN=…` rule: it
  // false-positived on legit `GITLAB_TOKEN = identifier` source, and a real value
  // is a token shape caught here regardless of the variable name.
  {
    id: "gitlab-pat",
    re: /gl(?:agent|soat|ffct|imt|cbt|ptt|pat|oas|ft|rt|dt)-[A-Za-z0-9_-]{20,}/,
  },
];

// A PRIVATE-TOKEN whose value is a $VAR reference is the documented placeholder
// in CLAUDE.md/AGENTS.md, not a leaked credential.
const PLACEHOLDER_VALUE = /[:=]\s*["']?\$/;

/**
 * Internal: like scanText but also carries the matched value, used ONLY for the
 * synthetic-token exemption decision. The value never escapes this module.
 * @param {string} text
 * @returns {{pattern:string, line:number, value:string}[]}
 */
function scanTextDetailed(text) {
  /** @type {{pattern:string, line:number, value:string}[]} */
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const p of SECRET_PATTERNS) {
      const re = new RegExp(p.re.source, "gi");
      // Surface every DISTINCT matched value on the line, not just the first: a
      // synthetic token must not mask a real one after it on the same line when
      // the fixture exemption drops the synthetic downstream.
      const seen = new Set();
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        if (p.placeholderExempt && PLACEHOLDER_VALUE.test(m[0])) continue;
        if (seen.has(m[0])) continue;
        seen.add(m[0]);
        hits.push({ pattern: p.id, line: i + 1, value: m[0] });
      }
    }
  }
  return hits;
}

/**
 * Scan text for secret shapes. Returns {pattern, line} (1-based), never the
 * matched value. The placeholder exemption is applied per match so a placeholder
 * never masks a real secret elsewhere on the same line.
 * @param {string} text
 * @returns {{pattern:string, line:number}[]}
 */
export function scanText(text) {
  return scanTextDetailed(text).map((h) => ({
    pattern: h.pattern,
    line: h.line,
  }));
}

/** Internal detailed buffer scan (binary-guarded), carrying matched values. */
function scanBufferDetailed(buf) {
  // Decode the WHOLE buffer as latin1 (byte to char 1:1 with the ASCII secret
  // shapes), splitting NUL bytes into line breaks. A secret anywhere is scanned,
  // whether after an early NUL or deep in a large file: no head/tail interior
  // gap, so a token can never hide behind a NUL or past a size bound.
  const NUL = String.fromCharCode(0);
  return scanTextDetailed(buf.toString("latin1").split(NUL).join("\n"));
}

/**
 * Scan a file buffer for secret shapes; a NUL byte splits islands rather than
 * truncating, and the whole buffer is scanned, so a token cannot hide behind an
 * early NUL or in the interior of a large file.
 * @param {Buffer} buf
 * @returns {{pattern:string, line:number}[]}
 */
export function scanBuffer(buf) {
  return scanBufferDetailed(buf).map((h) => ({
    pattern: h.pattern,
    line: h.line,
  }));
}

/**
 * A test/spec/fixture file whose synthetic tokens exist to exercise tooling —
 * NOT a credential store. Only a RECOGNIZABLY SYNTHETIC token in such a path is
 * exempted (see isSyntheticSecretValue); a real secret is still fail-closed.
 * @param {string} rel path relative to the pack root, forward-slashed
 */
export function isTestFixturePath(rel) {
  return /(^|\/)(tests?|__tests__|__fixtures__|fixtures|cypress)(\/)|\.(test|spec|cy)\.[cm]?[jt]sx?$/i.test(
    String(rel || ""),
  );
}

/** A run of consecutive ascending/descending chars (ABCDEF, 543210). */
function isSequentialRun(s) {
  if (s.length < 4) return false;
  let asc = true;
  let desc = true;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (d !== 1) asc = false;
    if (d !== -1) desc = false;
  }
  return asc || desc;
}

/**
 * Whether a secret-shaped MATCH is recognizably SYNTHETIC (a test fixture) and
 * so may be exempted in a test/fixture path. FAIL-CLOSED: a real, high-entropy
 * credential matches none of these shapes and is therefore never exempted.
 *   - private-key: NEVER synthetic. A BEGIN header is high-signal on its own and
 *     any "material present" heuristic is defeatable (split/wrapped body, no END
 *     footer, forged diff headers), so a private-key header always fails closed.
 *     The repo's own private-key TEST FIXTURES build the header by concatenation
 *     so their source does not match the scanner in the first place.
 *   - other tokens: the body (after the shape prefix) is a single repeated char,
 *     a sequential run, or drawn from a tiny (<=4) alphabet.
 * @param {string} pattern pattern id that fired
 * @param {string} value exact matched substring
 */
function isSyntheticSecretValue(pattern, value) {
  if (pattern === "private-key") return false;
  const body = String(value || "")
    .replace(/^PRIVATE-TOKEN\s*[:=]\s*/i, "")
    .replace(
      /^(AKIA|gh[pousr]_|sk-|gl(?:agent|soat|ffct|imt|cbt|ptt|pat|oas|ft|rt|dt)-)/i,
      "",
    )
    .replace(/[^A-Za-z0-9]/g, "");
  if (!body) return true;
  if (/^(.)\1+$/i.test(body)) return true; // one repeated char (aaaa / AAAA)
  if (isSequentialRun(body)) return true; // ABCDEFGHIJKLMNOP
  if (new Set(body.toLowerCase().split("")).size <= 4) return true; // ZZZZ0000
  return false; // high-entropy / unknown => NOT synthetic => fail closed
}

/**
 * Scan only ADDED lines (`+`, not the `+++` file header) of a unified diff, so
 * pre-existing base content carried in the diff never trips the scan. When
 * `exemptSyntheticIn(path)` is supplied, an added-line hit in a matched
 * (test/fixture) file is dropped ONLY if the value is recognizably synthetic; a
 * real secret in the same file still fires (fail-closed). A private-key header
 * is NEVER synthetic (see isSyntheticSecretValue), so no per-file/material
 * heuristic is needed and a forged `+++` content line cannot smuggle a key.
 * @param {Buffer|string} diff
 * @param {{ exemptSyntheticIn?: (path:string)=>boolean }} [opts]
 * @returns {{pattern:string, line:number}[]}
 */
export function scanAddedDiffLines(diff, opts = {}) {
  /** @type {{pattern:string, line:number}[]} */
  const hits = [];
  const lines = String(diff).split(/\r?\n/);
  let fixtureEligible = false;
  let inHunk = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^diff --git /.test(l)) {
      inHunk = false; // a new file's header region begins
      continue;
    }
    if (l.startsWith("@@")) {
      inHunk = true; // hunk body: `--- `/`+++ ` here are CONTENT, not headers
      continue;
    }
    // A real `+++ b/<path>` file header is `+++ ` (space), preceded by `--- `,
    // and in the file-header region (NOT inside a @@ hunk). A `+++…` line that is
    // no-space, has no `--- ` predecessor, or sits mid-hunk (a removed `-- x`
    // renders as `--- x`, an added `++ secret` as `+++ secret`) is CONTENT and
    // MUST be scanned, or a secret ships on it unscanned.
    if (!inHunk && /^\+\+\+ /.test(l) && /^--- /.test(lines[i - 1] || "")) {
      const p = l.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      fixtureEligible = Boolean(
        opts.exemptSyntheticIn && opts.exemptSyntheticIn(p),
      );
      continue;
    }
    if (l[0] !== "+") continue;
    for (const h of scanTextDetailed(l.slice(1))) {
      if (fixtureEligible && isSyntheticSecretValue(h.pattern, h.value))
        continue;
      hits.push({ pattern: h.pattern, line: i + 1 });
    }
  }
  return hits;
}

/**
 * Scan ONE packed file's full content, applying the same fixture-synthetic
 * exemption as the staging-dir scan when `exemptTestFixtures` is set: a
 * recognizably synthetic token in a test/fixture path is dropped, but a real,
 * high-entropy secret (or a private key with material) in ANY path is reported
 * (fail-closed). Used by panel-pack, which walks its own tree (that INCLUDES the
 * scanner's synthetic fixtures) file by file rather than staging a diff.
 * @param {string} rel forward-slashed repo-relative path
 * @param {Buffer} buf
 * @param {{ exemptTestFixtures?: boolean }} [opts]
 * @returns {{pattern:string, line:number}[]}
 */
export function scanPackFile(rel, buf, opts = {}) {
  const isFixture = opts.exemptTestFixtures !== false && isTestFixturePath(rel);
  /** @type {{pattern:string, line:number}[]} */
  const out = [];
  for (const h of scanBufferDetailed(buf)) {
    if (isFixture && isSyntheticSecretValue(h.pattern, h.value)) continue;
    out.push({ pattern: h.pattern, line: h.line });
  }
  return out;
}

/**
 * Scan a review-pack staging dir the way /review-pack does: every file at full
 * content except `changes.diff`, plus only the added lines of `changes.diff`.
 *
 * `exemptTestFixtures` (default true) drops ONLY recognizably synthetic tokens
 * (see isSyntheticSecretValue) found in test/spec/fixture files, whose fixtures
 * (e.g. the scanner's own) would otherwise refuse every pack. A real, high-
 * entropy credential in ANY file — including a test path — is still reported,
 * so fail-closed handling of an actual leaked credential is preserved.
 * @param {string} dir
 * @param {{ exemptTestFixtures?: boolean }} [opts]
 * @returns {{file:string, line:number, pattern:string}[]}
 */
export function scanStagingDir(dir, opts = {}) {
  const exempt = opts.exemptTestFixtures !== false;
  /** @type {{file:string, line:number, pattern:string}[]} */
  const hits = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(dir, full).replace(/\\/g, "/");
      const buf = fs.readFileSync(full);
      if (rel === "changes.diff") {
        for (const h of scanAddedDiffLines(buf, {
          exemptSyntheticIn: exempt ? isTestFixturePath : undefined,
        }))
          hits.push({ file: rel, line: h.line, pattern: h.pattern });
        continue;
      }
      // A fixture path drops only synthetic hits; a real secret still counts.
      for (const h of scanPackFile(rel, buf, { exemptTestFixtures: exempt }))
        hits.push({ file: rel, line: h.line, pattern: h.pattern });
    }
  };
  walk(dir);
  return hits;
}

/**
 * Redacted one-line summary of hits: file, line, and which pattern fired — never
 * the matched value.
 * @param {{file?:string, line:number, pattern:string}[]} hits
 * @returns {string}
 */
export function formatHits(hits) {
  return hits
    .map((h) => `${h.file ?? "?"}:${h.line} [${h.pattern}]`)
    .join(", ");
}

/**
 * Throw a redacted error when any hit is present. Callers wrap the export so a
 * hit refuses the archive instead of shipping it.
 * @param {{file?:string, line:number, pattern:string}[]} hits
 * @param {string} label
 */
export function assertClean(hits, label = "content") {
  if (hits.length) {
    throw new Error(
      `Potential secret(s) detected in ${label}: ${formatHits(hits)} — export refused.`,
    );
  }
}
