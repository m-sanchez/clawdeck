// @ts-check
/**
 * Exit-status-aware git execution. `git()` cannot tell "no" from "could not
 * tell" - both are "". Every fact whose answer is the exit code goes through
 * `gitResult()` instead, so a false answer and a failed command stay apart.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitResult } from "../server/lib/git.mjs";

let repo = "";
let first = "";
let second = "";

/** Commit `file` with `body` and return the new HEAD sha. */
function commit(file, body, message) {
  writeFileSync(join(repo, file), body);
  execFileSync("git", ["add", "-A"], { cwd: repo, windowsHide: true });
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
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    windowsHide: true,
    encoding: "utf8",
  }).trim();
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "clawdeck-gitresult-"));
  execFileSync("git", ["init", "-q"], { cwd: repo, windowsHide: true });
  first = commit("kept.txt", "one\n", "first");
  second = commit("kept.txt", "one\ntwo\n", "second");
});
after(() => rmSync(repo, { recursive: true, force: true }));

test("--is-ancestor separates true, false and unable-to-tell", async () => {
  const yes = await gitResult(
    ["merge-base", "--is-ancestor", first, "HEAD"],
    repo,
  );
  assert.equal(yes.code, 0);
  assert.equal(yes.ok, true);

  const no = await gitResult(
    ["merge-base", "--is-ancestor", second, first],
    repo,
  );
  assert.equal(no.code, 1);
  assert.equal(no.ok, false);

  const broken = await gitResult(
    ["merge-base", "--is-ancestor", "0".repeat(40), "HEAD"],
    repo,
  );
  assert.equal(broken.ok, false);
  assert.notEqual(
    broken.code,
    1,
    "an unknown sha must not read as 'not an ancestor'",
  );

  // The distinction git() cannot make: all three look identical through it.
  const viaGit = await Promise.all([
    git(["merge-base", "--is-ancestor", first, "HEAD"], repo),
    git(["merge-base", "--is-ancestor", second, first], repo),
  ]);
  assert.deepEqual(viaGit, ["", ""]);
});

test("ls-tree separates present, absent and failed", async () => {
  const present = await gitResult(
    ["ls-tree", "--name-only", "HEAD", "--", "kept.txt"],
    repo,
  );
  assert.equal(present.code, 0);
  assert.match(present.stdout, /kept\.txt/);

  const absent = await gitResult(
    ["ls-tree", "--name-only", "HEAD", "--", "never-existed.txt"],
    repo,
  );
  assert.equal(absent.code, 0, "a missing path is a successful empty listing");
  assert.equal(absent.stdout.trim(), "");

  const failed = await gitResult(
    ["ls-tree", "--name-only", "no-such-ref", "--", "kept.txt"],
    repo,
  );
  assert.equal(failed.ok, false);
  assert.notEqual(failed.code, 0);
});

test("gitResult never rejects and reports a spawn failure as a null code", async () => {
  const bad = await gitResult(["rev-parse", "HEAD"], join(repo, "no-such-dir"));
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.stdout, "string");
  assert.equal(typeof bad.stderr, "string");
});

test("git() keeps its trimmed-string contract for existing consumers", async () => {
  const head = await git(["rev-parse", "HEAD"], repo);
  assert.equal(head, second);
  assert.equal(await git(["rev-parse", "no-such-ref"], repo), "");
});
