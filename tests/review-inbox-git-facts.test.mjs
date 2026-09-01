// @ts-check
/**
 * The git side of a review thread, against a real repository.
 *
 * These are the claims that turn into "likely addressed" on screen, so the
 * failure mode to guard is a confident wrong answer: a rebased anchor, a
 * deleted file or a failed command must all read as unknown, never as
 * "untouched".
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  anchorIsAncestor,
  collectGitFacts,
  fileExistsAtHead,
  filesTouchedSince,
  locateAnchorLine,
} from "../server/core/review-inbox/git-facts.mjs";

let repo = "";
let anchorSha = "";
let headSha = "";

const REVIEWED = "src/auth.ts";
/** 20 numbered lines; the review points at line 10. */
const original =
  Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function run(args) {
  return execFileSync("git", args, {
    cwd: repo,
    windowsHide: true,
    encoding: "utf8",
  }).trim();
}
function commit(message) {
  run(["add", "-A"]);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd: repo, windowsHide: true },
  );
  return run(["rev-parse", "HEAD"]);
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "clawdeck-gitfacts-"));
  execFileSync("git", ["init", "-q"], { cwd: repo, windowsHide: true });
  execFileSync("git", ["config", "core.autocrlf", "false"], {
    cwd: repo,
    windowsHide: true,
  });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "untouched.txt"), "stable\n");
  writeFileSync(join(repo, REVIEWED), original);
  anchorSha = commit("anchor");

  // Three lines inserted above the reviewed line: it moves, it does not change.
  const inserted = ["// new", "// new", "// new", ""].join("\n");
  writeFileSync(join(repo, REVIEWED), inserted + original);
  headSha = commit("insert above");
});

after(() => rmSync(repo, { recursive: true, force: true }));

test("an ancestor anchor is true; a descendant is false, not unknown", async () => {
  assert.deepEqual((await anchorIsAncestor(anchorSha, repo)).value, true);
  const backwards = await anchorIsAncestor(headSha, repo, {
    gitResult: async () => ({ ok: false, code: 1, stdout: "", stderr: "" }),
  });
  assert.equal(backwards.value, false);
  assert.match(backwards.reason, /not an ancestor/);
});

test("an unreachable anchor is unknown rather than 'not an ancestor'", async () => {
  const r = await anchorIsAncestor("0".repeat(40), repo);
  assert.equal(r.value, null);
  assert.match(r.reason, /could not/);
});

test("files touched since the anchor are listed, commit headers excluded", async () => {
  const r = await filesTouchedSince(anchorSha, repo);
  assert.ok(r.files.has(REVIEWED));
  assert.equal(r.files.has("untouched.txt"), false);
});

test("file existence separates present, deleted and unsafe paths", async () => {
  assert.equal((await fileExistsAtHead(REVIEWED, repo)).value, true);
  assert.equal((await fileExistsAtHead("src/never.ts", repo)).value, false);

  const escape = await fileExistsAtHead("../outside.txt", repo);
  assert.equal(escape.value, null, "an unsafe path must never reach git");
  assert.match(escape.reason, /not a safe repo path/);
});

test("the reviewed line is mapped before blame, and blame uses the mapped line", async () => {
  const seen = [];
  const located = await locateAnchorLine(
    { file: REVIEWED, line: 10, anchorCommitSha: anchorSha },
    repo,
    {
      gitResult: async (args, cwd) => {
        seen.push(args);
        const { gitResult } = await import("../server/lib/git.mjs");
        return gitResult(args, cwd);
      },
    },
  );

  assert.equal(located.mapping.kind, "unchanged-mapped");
  assert.equal(
    located.mapping.currentLine,
    13,
    "three lines were inserted above",
  );
  const blame = seen.find((a) => a[0] === "blame");
  assert.ok(blame, "blame should run once the line is mapped");
  assert.equal(
    blame[2],
    "13,13",
    "blame must use the mapped line, not the anchor",
  );
  assert.equal(blame[blame.indexOf("--") + 1], REVIEWED);
  assert.ok(
    blame.indexOf("--") < blame.indexOf(REVIEWED),
    "the path goes after --",
  );
});

test("collectGitFacts groups anchors and reports one file's real state", async () => {
  const calls = [];
  const { gitResult } = await import("../server/lib/git.mjs");
  const facts = await collectGitFacts(
    repo,
    [
      {
        id: "a",
        location: { file: REVIEWED, line: 10, anchorCommitSha: anchorSha },
      },
      {
        id: "b",
        location: { file: REVIEWED, line: 18, anchorCommitSha: anchorSha },
      },
      { id: "c", location: null },
    ],
    {
      gitResult: async (args, cwd) => {
        calls.push(args.join(" "));
        return gitResult(args, cwd);
      },
    },
  );

  const logs = calls.filter((c) => c.startsWith("log "));
  assert.equal(
    logs.length,
    1,
    "one log call per distinct anchor, not per thread",
  );

  const a = facts.get("a");
  assert.equal(a.anchorValid, true);
  assert.equal(a.fileExists, true);
  assert.equal(a.fileChanged, true);
  assert.equal(a.mapping.currentLine, 13);
  assert.ok(a.reasons.length > 0);

  const c = facts.get("c");
  assert.equal(c.anchorValid, null);
  assert.deepEqual(c.unknowns, ["anchor"]);
});

test("a rebased anchor makes everything unknown, never 'untouched'", async () => {
  const facts = await collectGitFacts(
    repo,
    [
      {
        id: "x",
        location: { file: REVIEWED, line: 10, anchorCommitSha: "0".repeat(40) },
      },
    ],
    {},
  );
  const f = facts.get("x");
  assert.equal(f.anchorValid, null);
  assert.equal(f.fileChanged, null, "never false");
  assert.ok(f.unknowns.includes("anchor"));
  assert.ok(f.unknowns.includes("file-changed"));
});

test("past the probe cap the line-level answer is unknown, not assumed", async () => {
  const facts = await collectGitFacts(
    repo,
    [
      {
        id: "p1",
        location: { file: REVIEWED, line: 10, anchorCommitSha: anchorSha },
      },
      {
        id: "p2",
        location: { file: REVIEWED, line: 11, anchorCommitSha: anchorSha },
      },
    ],
    { lineProbeMax: 1 },
  );
  assert.equal(facts.get("p1").mapping.kind, "unchanged-mapped");
  assert.equal(facts.get("p2").mapping, null);
  assert.ok(facts.get("p2").unknowns.includes("line-level"));
});

test("a deleted file reads as deleted, and its line answer stays unknown", async () => {
  unlinkSync(join(repo, REVIEWED));
  commit("delete the reviewed file");
  const facts = await collectGitFacts(
    repo,
    [
      {
        id: "d",
        location: { file: REVIEWED, line: 10, anchorCommitSha: anchorSha },
      },
    ],
    {},
  );
  const f = facts.get("d");
  assert.equal(f.fileExists, false);
  assert.equal(f.mapping, null);
  assert.ok(f.unknowns.includes("line-level"));
});

test("no compound path forms exist in the source", () => {
  const src = readFileSync(
    fileURLToPath(
      new URL("../server/core/review-inbox/git-facts.mjs", import.meta.url),
    ),
    "utf8",
  );
  assert.equal(
    /-L[^"']*:\$\{/.test(src),
    false,
    "no `git log -L<line>:<path>` form",
  );
  assert.equal(/HEAD:\$\{/.test(src), false, "no `HEAD:<path>` form");
});
