// @ts-check
/**
 * Task evidence, against a real repository.
 *
 * The failure this guards is the tempting one: a commit that lands while a task
 * is running is not thereby the task's commit. Attribution requires the commit
 * to touch files the task actually changed, and where that is ambiguous the
 * honest answer is that no commit is attributed.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectTaskEvidence,
  testEvidence,
} from "../server/core/tasks/evidence.mjs";

let repo = "";
let taskStart = "";
let baselineSha = "";

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
      "user.name=T",
      "-c",
      "user.email=t@e.com",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd: repo, windowsHide: true },
  );
  return run(["rev-parse", "HEAD"]);
}

const task = (over = {}) => ({
  id: "task_aaaaaaaaaaaa",
  startedAt: taskStart,
  baselineSha,
  ...over,
});

before(() => {
  repo = mkdtempSync(join(tmpdir(), "clawdeck-evidence-"));
  execFileSync("git", ["init", "-q"], { cwd: repo, windowsHide: true });
  execFileSync("git", ["config", "core.autocrlf", "false"], {
    cwd: repo,
    windowsHide: true,
  });
  writeFileSync(join(repo, "auth.ts"), "original\n");
  writeFileSync(join(repo, "unrelated.ts"), "original\n");
  baselineSha = commit("before the task");
  // The task starts here. The baseline commit is what bounds the evidence
  // range; the timestamp is only a fallback for tasks bound before baselines.
  taskStart = new Date(Date.now() - 1000).toISOString();
});

after(() => rmSync(repo, { recursive: true, force: true }));

test("a task with no binding yields no evidence, and says why", async () => {
  const e = await collectTaskEvidence(repo, task({ startedAt: null, baselineSha: null }));
  assert.deepEqual(e.files, []);
  assert.equal(e.commit, null);
  assert.ok(e.unknowns.includes("start-time"));
  assert.match(e.reasons[0], /not been bound/);
});

test("uncommitted work counts as work the task did", async () => {
  writeFileSync(join(repo, "auth.ts"), "changed by the task\n");
  const e = await collectTaskEvidence(repo, task());
  assert.ok(e.files.includes("auth.ts"));
  assert.ok(e.dirty.includes("auth.ts"));
  assert.equal(e.commit, null, "nothing is committed yet");
});

test("a commit is attributed only when it touches the task's files", async () => {
  const sha = commit("the task's change");
  const e = await collectTaskEvidence(repo, task());

  assert.equal(e.commit.sha, sha);
  assert.ok(e.commit.files.includes("auth.ts"));
  assert.match(e.reasons.join(" "), /touches 1 file/);
});

test("a commit that only lands nearby in time is not the task's", async () => {
  // A task whose baseline is the current HEAD sees nothing after it.
  const other = await collectTaskEvidence(repo, {
    id: "task_bbbbbbbbbbbb",
    startedAt: new Date().toISOString(),
    baselineSha: run(["rev-parse", "HEAD"]),
  });
  assert.equal(other.commit, null, "nothing has landed since its baseline");

  // And a task whose files were never touched by the commit gets nothing.
  writeFileSync(join(repo, "unrelated.ts"), "someone else's edit\n");
  const e = await collectTaskEvidence(repo, task());
  assert.ok(e.files.includes("unrelated.ts"), "it is dirty, so it is in scope");
  assert.ok(e.commit, "the earlier commit still overlaps auth.ts");
  assert.equal(
    e.commit.files.includes("unrelated.ts"),
    false,
    "the commit itself never touched it",
  );
});

test("a git failure reports unknown rather than 'nothing changed'", async () => {
  const failing = async () => ({
    ok: false,
    code: 128,
    stdout: "",
    stderr: "boom",
  });
  const e = await collectTaskEvidence(repo, task(), { gitResult: failing });

  assert.deepEqual(e.files, []);
  assert.ok(e.unknowns.includes("working-tree"));
  assert.ok(e.unknowns.includes("commits"));
  assert.equal(
    e.reasons.includes("no files changed since the task started"),
    false,
    "an unreadable repository is not an empty one",
  );
});

test("test evidence is observed, never assumed", () => {
  assert.deepEqual(testEvidence(null), { tests: [], unknown: true });
  const seen = testEvidence({
    checks: [
      { id: "unit", label: "Unit", status: "passed" },
      { id: "lint", label: "Lint", status: "skipped" },
    ],
  });
  assert.equal(seen.unknown, false);
  assert.equal(seen.tests.length, 1, "a skipped check is not a result");
  assert.equal(seen.tests[0].status, "passed");
});

test("a task bound without a baseline falls back to time, and says so", async () => {
  const e = await collectTaskEvidence(repo, task({ baselineSha: null }));
  assert.ok(
    e.unknowns.includes("time-based-window"),
    "a timestamp window is weaker evidence and is labelled as such",
  );
});
