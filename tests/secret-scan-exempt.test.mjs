// @ts-check
/**
 * Pack secret-scan test-fixture exemption: synthetic tokens in test/spec files
 * must not refuse a pack, while a real leaked secret in config/source (or the
 * added lines of a non-test file) is still fail-closed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isTestFixturePath,
  scanStagingDir,
  scanAddedDiffLines,
  scanPackFile,
} from "../server/lib/secret-scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AKIA = "AKIA" + "ABCDEFGHIJKLMNOP";

test("the scanner's own test files pack clean (no self-flag)", () => {
  // panel-pack walks its own tree; the scanner's fixtures must not refuse it.
  for (const f of ["secret-scan.test.mjs", "secret-scan-exempt.test.mjs"]) {
    const buf = fs.readFileSync(path.join(HERE, f));
    const hits = scanPackFile("panel/tests/" + f, buf);
    assert.equal(
      hits.length,
      0,
      `${f} self-flags when packed: ${hits.map((h) => `${h.line} ${h.pattern}`).join(", ")}`,
    );
  }
});
// Built by concatenation: the VALUE matches the scanner, this SOURCE does not
// self-flag when packed. A private-key header is NEVER fixture-exempt now, so
// these tests would otherwise refuse the pack of this very file.
const PK_HEADER = "-----BEGIN RSA " + "PRIVATE KEY-----";
const PK_END = "-----END RSA " + "PRIVATE KEY-----";

test("isTestFixturePath recognises test/spec/fixture paths only", () => {
  assert.equal(isTestFixturePath("panel/tests/secret-scan.test.mjs"), true);
  assert.equal(isTestFixturePath("src/foo.spec.ts"), true);
  assert.equal(isTestFixturePath("client/cypress/e2e/x.cy.ts"), true);
  assert.equal(isTestFixturePath("__fixtures__/creds.json"), true);
  assert.equal(isTestFixturePath("server/src/config.ts"), false);
  assert.equal(isTestFixturePath(".claude/settings.local.json"), false);
});

test("a synthetic secret in a test file does not refuse the pack", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-"));
  fs.mkdirSync(path.join(dir, "current", "panel", "tests"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dir, "current", "panel", "tests", "scan.test.mjs"),
    `const FAKE = "${AKIA}";\n`,
  );
  const hits = scanStagingDir(dir);
  assert.equal(hits.length, 0, "test-fixture synthetic token is exempt");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a real secret in a NON-test file still refuses the pack", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-"));
  fs.mkdirSync(path.join(dir, "current", "server", "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "current", "server", "src", "config.ts"),
    `export const KEY = "${AKIA}";\n`,
  );
  const hits = scanStagingDir(dir);
  assert.ok(hits.length >= 1, "source-file secret is still caught");
  assert.equal(hits[0].pattern, "aws-akia");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("changes.diff: added secret in a test file exempt, in a source file caught", () => {
  const diff = [
    "diff --git a/src/config.ts b/src/config.ts",
    "--- a/src/config.ts",
    "+++ b/src/config.ts",
    `+const KEY = "${AKIA}";`,
    "diff --git a/tests/x.test.mjs b/tests/x.test.mjs",
    "--- a/tests/x.test.mjs",
    "+++ b/tests/x.test.mjs",
    `+const FAKE = "${AKIA}";`,
  ].join("\n");
  const hits = scanAddedDiffLines(diff, {
    exemptSyntheticIn: isTestFixturePath,
  });
  assert.equal(hits.length, 1, "only the source-file added secret is flagged");
});

test("changes.diff: a REAL secret added to a test file is still flagged", () => {
  const REAL = "AKIA" + "J5X2Q9R7K3MZ1N8P";
  const diff = [
    "diff --git a/tests/x.test.mjs b/tests/x.test.mjs",
    "--- a/tests/x.test.mjs",
    "+++ b/tests/x.test.mjs",
    `+const OOPS = "${REAL}";`,
  ].join("\n");
  const hits = scanAddedDiffLines(diff, {
    exemptSyntheticIn: isTestFixturePath,
  });
  assert.equal(hits.length, 1, "a real secret is not exempted by the path");
});

test("changes.diff: a REAL private key in a fixture file is NOT exempt (fail-closed)", () => {
  const diff = [
    "--- a/cypress/fixtures/server.key",
    "+++ b/cypress/fixtures/server.key",
    "+" + PK_HEADER,
    "+MIIEpAIBAAKCAQEA" + "b".repeat(48),
    "+" + PK_END,
  ].join("\n");
  const hits = scanAddedDiffLines(diff, {
    exemptSyntheticIn: isTestFixturePath,
  });
  assert.ok(
    hits.some((h) => h.pattern === "private-key"),
    "a real key (with material) in a fixture diff must refuse",
  );
});

test("changes.diff: even a bare private-key header in a fixture is flagged (never exempt)", () => {
  const diff = [
    "--- a/tests/scan.test.mjs",
    "+++ b/tests/scan.test.mjs",
    `+const H = "${PK_HEADER}";`,
  ].join("\n");
  const hits = scanAddedDiffLines(diff, {
    exemptSyntheticIn: isTestFixturePath,
  });
  assert.ok(
    hits.some((h) => h.pattern === "private-key"),
    "a private-key header is never fixture-exempt",
  );
});

test("changes.diff: a split body + omitted END in a fixture path is still flagged", () => {
  // Attack B: base64 body wrapped < 40 chars/line and the END footer omitted, to
  // dodge a material heuristic. A private-key header is never exempt regardless.
  const lines = [
    "--- a/tests/x.test.mjs",
    "+++ b/tests/x.test.mjs",
    "+" + PK_HEADER,
  ];
  for (let i = 0; i < 20; i++) lines.push("+MIIEpAIBAAKCAQEA" + "bc".repeat(6));
  const hits = scanAddedDiffLines(lines.join("\n"), {
    exemptSyntheticIn: isTestFixturePath,
  });
  assert.ok(hits.some((h) => h.pattern === "private-key"));
});

test("changes.diff: forged +++ headers cannot exempt a private key in a diff-only carrier", () => {
  // Attack A: forged `+++` content lines reassign the exemption path + split the
  // per-file context. A private-key header is never exempt, so it still fires.
  const diff = [
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "+++ b/a.test.js", // forged content line
    "+" + PK_HEADER,
    "+++ b/b.test.js", // forged content line
    "+MIIEpAIBAAKCAQEA" + "b".repeat(60),
    "+" + PK_END,
  ].join("\n");
  const hits = scanAddedDiffLines(diff, {
    exemptSyntheticIn: isTestFixturePath,
  });
  assert.ok(
    hits.some((h) => h.pattern === "private-key"),
    "a real key is flagged despite forged headers",
  );
});

test("exemption is opt-out: exemptTestFixtures:false scans everything", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-"));
  fs.mkdirSync(path.join(dir, "current", "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "current", "tests", "x.test.mjs"),
    `const FAKE = "${AKIA}";\n`,
  );
  assert.equal(scanStagingDir(dir, { exemptTestFixtures: false }).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The exemption is fail-CLOSED: it only covers recognizably synthetic tokens
// (sequential / repeated / tiny-alphabet / placeholder). A REAL high-entropy
// secret in a test path must still refuse the pack.
const REAL_AKIA = "AKIA" + "J5X2Q9R7K3MZ1N8P"; // random-shaped 16-char body

test("a REAL high-entropy secret in a test file is NOT exempt (fail-closed)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-"));
  fs.mkdirSync(path.join(dir, "current", "panel", "tests"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dir, "current", "panel", "tests", "leak.test.mjs"),
    `const OOPS = "${REAL_AKIA}";\n`,
  );
  const hits = scanStagingDir(dir);
  assert.ok(
    hits.some((h) => h.pattern === "aws-akia"),
    "a real high-entropy secret in a test path must still refuse",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a private key WITH real material in a fixture path is NOT exempt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-"));
  fs.mkdirSync(path.join(dir, "current", "fixtures"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "current", "fixtures", "key.pem"),
    PK_HEADER + "\nMIIEpAIBAAKCAQEA" + "b".repeat(48) + "\n" + PK_END + "\n",
  );
  const hits = scanStagingDir(dir);
  assert.ok(
    hits.some((h) => h.pattern === "private-key"),
    "a private key with real material must refuse even in a fixture path",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scanPackFile: exempts synthetic fixtures, catches a real secret (panel-pack)", () => {
  const REAL = "AKIA" + "J5X2Q9R7K3MZ1N8P";
  // Synthetic token in a fixture path -> exempt (so panel-pack can pack itself).
  assert.equal(
    scanPackFile(
      "panel/tests/scan.test.mjs",
      Buffer.from(`const F = "${AKIA}";`),
    ).length,
    0,
  );
  // A real high-entropy token in a fixture path -> still flagged.
  assert.ok(
    scanPackFile(
      "panel/tests/scan.test.mjs",
      Buffer.from(`const R = "${REAL}";`),
    ).some((h) => h.pattern === "aws-akia"),
  );
  // Any token in a non-fixture path -> flagged.
  assert.ok(
    scanPackFile(
      "panel/server/config.mjs",
      Buffer.from(`const S = "${AKIA}";`),
    ).some((h) => h.pattern === "aws-akia"),
  );
});

test("a bare private-key HEADER in a test file is FLAGGED (never exempt)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-"));
  fs.mkdirSync(path.join(dir, "current", "panel", "tests"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dir, "current", "panel", "tests", "scan.test.mjs"),
    `const H = "${PK_HEADER}";\n`,
  );
  assert.ok(
    scanStagingDir(dir).some((h) => h.pattern === "private-key"),
    "a private-key header is never fixture-exempt (fail-closed)",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
