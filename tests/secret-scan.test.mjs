// @ts-check
/** Unit tests for the shared secret scanner. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scanText,
  scanBuffer,
  scanAddedDiffLines,
  scanStagingDir,
  isTestFixturePath,
  formatHits,
  assertClean,
} from "../server/lib/secret-scan.mjs";

// Synthetic, non-real tokens shaped to match each pattern. Built by
// concatenation so the VALUE matches the scanner but this test file's SOURCE
// does not self-flag when the scanner packs itself.
const FAKE = {
  privateKey: "-----BEGIN RSA " + "PRIVATE KEY-----",
  privateToken: "PRIVATE-TOKEN: glpat-ZZZZ0000ZZZZ0000ZZZZ",
  akia: "AKIA" + "ABCDEFGHIJKLMNOP",
  github: "ghp_" + "a".repeat(30),
  openai: "sk-" + "A".repeat(20),
};

test("scanText flags each high-confidence pattern", () => {
  assert.equal(scanText(FAKE.privateKey)[0].pattern, "private-key");
  assert.equal(scanText(FAKE.privateToken)[0].pattern, "private-token");
  assert.equal(scanText(FAKE.akia)[0].pattern, "aws-akia");
  assert.equal(scanText(FAKE.github)[0].pattern, "github-token");
  assert.equal(scanText(FAKE.openai)[0].pattern, "openai-key");
});

test("scanText reports 1-based line numbers, not values", () => {
  const hits = scanText(`clean line\nmore\n${FAKE.github}\n`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
  assert.deepEqual(Object.keys(hits[0]).sort(), ["line", "pattern"]);
});

test("PRIVATE-TOKEN: $VAR placeholder is exempt", () => {
  assert.deepEqual(scanText("PRIVATE-TOKEN: $GITLAB_TOKEN"), []);
  assert.deepEqual(scanText('Private-Token: "$GITLAB_TOKEN"'), []);
});

test("a bare gitlab PAT and a GITLAB_TOKEN assignment are flagged", () => {
  // Concatenated so this file's SOURCE carries no contiguous glpat-<20+> that
  // would self-flag when the scanner packs itself; the runtime VALUE matches.
  const pat = "glpat-" + "3xK9pQ7wZ2mNvB4tL6rS";
  assert.equal(scanText(pat)[0]?.pattern, "gitlab-pat");
  assert.ok(
    scanText(`export GITLAB_TOKEN=${pat}`).some(
      (h) => h.pattern === "gitlab-pat",
    ),
    "an assigned bare PAT is caught",
  );
  assert.ok(
    scanText(`GITLAB_TOKEN: ${pat}`).length > 0,
    "a GITLAB_TOKEN header carrying a PAT is caught",
  );
  // The documented $VAR placeholder stays exempt.
  assert.deepEqual(scanText("GITLAB_TOKEN=$GITLAB_TOKEN"), []);
});

test("a GITLAB_TOKEN variable assignment (not a literal) is not a false positive", () => {
  // Source code referencing the env-var NAME must not refuse a pack; only the
  // real token SHAPE (gitlab-pat) is a leak.
  assert.deepEqual(scanText("s.env.GITLAB_TOKEN = gitlabToken;"), []);
  assert.deepEqual(
    scanText("const GITLAB_TOKEN = process.env.GITLAB_TOKEN;"),
    [],
  );
  // A real bare PAT is still caught (by gitlab-pat), assignment or not.
  const pat = "glpat-" + "Xk9mQ2pL7vB3nR8sT4wZ";
  assert.ok(
    scanText(`GITLAB_TOKEN = "${pat}"`).some((h) => h.pattern === "gitlab-pat"),
  );
});

test("openai-key does not false-positive on ordinary hyphenated words", () => {
  for (const word of [
    "risk-assessment-configuration-panel",
    "disk-usage-monitor-component-view",
    "task-oriented-programming-model-v2",
    "mask-layer-rendering-pipeline-step",
  ])
    assert.deepEqual(scanText(word), [], `must not flag ${word}`);
  // A real boundary-anchored sk- key (with entropy) is still caught.
  const key = "sk-" + "aB3xY7zQ1mN5pR8sT2wK";
  assert.equal(scanText(key)[0]?.pattern, "openai-key");
});

test("gitlab-pat covers the REAL token family (agent/oauth/feed/mail/flags)", () => {
  const body = "Xk9mQ2pL7vB3nR8sT4wZ"; // high-entropy stand-in
  // Real GitLab prefixes, including the feed/incoming-mail/feature-flags-client
  // tokens the earlier (invented) alternation missed.
  for (const prefix of ["glagent-", "gloas-", "glft-", "glimt-", "glffct-"]) {
    assert.equal(
      scanText(prefix + body)[0]?.pattern,
      "gitlab-pat",
      `must flag ${prefix}…`,
    );
  }
});

test("scanText emits every distinct same-pattern token on a line (no early break)", () => {
  const a = "glpat-" + "AAAAAAAAAAAAAAAAAAAA"; // synthetic
  const b = "glpat-" + "Xk9mQ2pL7vB3nR8sT4wZ"; // high-entropy stand-in
  const pats = scanText(`x=["${a}","${b}"]`).filter(
    (h) => h.pattern === "gitlab-pat",
  );
  assert.equal(
    pats.length,
    2,
    "both same-pattern tokens on a line are reported",
  );
});

test("a real token after a synthetic one on a fixture line still fires", () => {
  const synthetic = "glpat-" + "AAAAAAAAAAAAAAAAAAAA"; // exempt in a fixture path
  const real = "glpat-" + "Xk9mQ2pL7vB3nR8sT4wZ"; // must still fire
  const diff = [
    "diff --git a/tests/x.spec.ts b/tests/x.spec.ts",
    "--- a/tests/x.spec.ts",
    "+++ b/tests/x.spec.ts",
    "@@ -0,0 +1 @@",
    `+const t = ["${synthetic}","${real}"]`,
  ].join("\n");
  const hits = scanAddedDiffLines(diff, {
    exemptSyntheticIn: isTestFixturePath,
  });
  assert.ok(
    hits.length >= 1,
    "the real token is not masked by the exempt synthetic one",
  );
});

test("scanBuffer scans the interior of a >2 MiB buffer (no head/tail gap)", () => {
  const tok = "glpat-" + "Xk9mQ2pL7vB3nR8sT4wZ";
  const filler = Buffer.alloc(1.5 * 1024 * 1024, 0x78); // 'x'
  const buf = Buffer.concat([filler, Buffer.from(`\n${tok}\n`), filler]);
  assert.ok(buf.length > 2 * 1024 * 1024);
  assert.equal(
    scanBuffer(buf).length,
    1,
    "a secret mid-buffer is still caught",
  );
});

test("a placeholder never masks a real secret elsewhere on the line", () => {
  // Different pattern on the same line still fires.
  const line = `curl -H "PRIVATE-TOKEN: $GITLAB_TOKEN" ${FAKE.openai}`;
  const ids = scanText(line).map((h) => h.pattern);
  assert.ok(ids.includes("openai-key"));
  assert.ok(!ids.includes("private-token"));

  // A real PRIVATE-TOKEN after a placeholder PRIVATE-TOKEN still fires. The token
  // is concatenated + interpolated so this file's SOURCE reads as a `$`
  // placeholder (exempt) and does not self-flag when the scanner packs itself.
  const tok = "glpat-real" + "ABCDEF0123";
  const two = `PRIVATE-TOKEN: $VAR then PRIVATE-TOKEN: ${tok}`;
  assert.ok(scanText(two).some((h) => h.pattern === "private-token"));
});

test("scanBuffer catches a secret before OR after a NUL byte", () => {
  const before = Buffer.concat([
    Buffer.from(FAKE.github + "\n"),
    Buffer.from([0]),
  ]);
  assert.equal(scanBuffer(before).length, 1, "secret before a NUL is caught");
  assert.equal(scanBuffer(Buffer.from(FAKE.github)).length, 1);
  // A secret entirely AFTER an early NUL is caught too: a NUL splits the buffer
  // into lines rather than truncating it, so a binary blob cannot hide a token.
  const after = Buffer.concat([Buffer.from([0]), Buffer.from(FAKE.github)]);
  assert.equal(scanBuffer(after).length, 1, "secret after a NUL is caught");
});

test("scanAddedDiffLines flags added lines only, never +++ or removed", () => {
  const diff = [
    "--- a/x",
    "+++ b/x",
    `-${FAKE.akia}`, // removed base line -> ignored
    ` ${FAKE.github}`, // context line -> ignored
    `+${FAKE.openai}`, // added -> flagged
  ].join("\n");
  const hits = scanAddedDiffLines(diff);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern, "openai-key");
});

test("a content line rendered as +++ (added text starting with ++) is scanned", () => {
  const REAL = "AKIA" + "J5X2Q9R7K3MZ1N8P";
  // Added content beginning with `++` renders as `+++…` in the diff; it is a
  // CONTENT line (no space after +++, not a `--- `/`+++ ` header pair), so it
  // must be scanned — otherwise a secret ships in a diff-only file.
  const diff = ["--- a/data.snap", "+++ b/data.snap", "+++" + REAL].join("\n");
  assert.ok(
    scanAddedDiffLines(diff).some((h) => h.pattern === "aws-akia"),
    "a secret on a ++-content line must be flagged",
  );
});

test("a MID-HUNK +++ <secret> after a removed -- line is scanned (forged header)", () => {
  const REAL = "AKIA" + "J5X2Q9R7K3MZ1N8P";
  // A real git diff renders a removed content line `-- decoy` as `--- decoy` and
  // an added content line `++ <secret>` as `+++ <secret>`. Inside a @@ hunk this
  // is CONTENT, not a `--- `/`+++ ` file-header pair — it must be scanned.
  const diff = [
    "diff --git a/secrets.lock b/secrets.lock",
    "--- a/secrets.lock",
    "+++ b/secrets.lock",
    "@@ -1,1 +1,1 @@",
    "--- decoy",
    "+++ " + REAL,
  ].join("\n");
  assert.ok(
    scanAddedDiffLines(diff).some((h) => h.pattern === "aws-akia"),
    "a mid-hunk forged +++ header must not skip the secret",
  );
});

test("scanStagingDir scans full content but only added diff lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-stage-"));
  fs.mkdirSync(path.join(dir, "current"));
  fs.writeFileSync(path.join(dir, "current", "foo.ts"), `ok\n${FAKE.github}\n`);
  fs.writeFileSync(
    path.join(dir, "changes.diff"),
    `+++ b/foo.ts\n-${FAKE.akia}\n+${FAKE.openai}\n`,
  );
  const hits = scanStagingDir(dir);
  const byFile = Object.fromEntries(hits.map((h) => [h.file, h.pattern]));
  assert.equal(byFile["current/foo.ts"], "github-token");
  assert.equal(byFile["changes.diff"], "openai-key");
  // The removed AKIA line in the diff must NOT be reported.
  assert.ok(!hits.some((h) => h.pattern === "aws-akia"));
});

test("assertClean / formatHits redact the value (file:line[pattern] only)", () => {
  const found = scanText(FAKE.openai).map((h) => ({ ...h, file: "current/x" }));
  const summary = formatHits(found);
  assert.equal(summary, "current/x:1 [openai-key]");
  assert.ok(!summary.includes(FAKE.openai));

  assert.throws(
    () => assertClean(found, "review pack"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Potential secret\(s\) detected/);
      assert.ok(!err.message.includes(FAKE.openai)); // value never leaks
      return true;
    },
  );
  assert.doesNotThrow(() => assertClean([], "review pack"));
});
