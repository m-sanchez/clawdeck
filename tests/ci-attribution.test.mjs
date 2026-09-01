// @ts-check
/**
 * Regression attribution is evidence-only.
 *
 * The failure mode this guards: a red build, one task in flight, and a panel
 * that says "this task broke it" because the timing fits. Blaming the wrong
 * change is worse than saying nothing - the engineer then debugs the wrong file
 * with the panel's authority behind them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attributeFailure,
  pathsFromLog,
} from "../server/core/tasks/attribution.mjs";

const FAILURE = { name: "windows / node 22", jobId: "12345" };
const LOG = [
  "not ok 3 - anchor maps through an insertion",
  "  at TestContext.<anonymous> (file:///D:/a/repo/tests/review-inbox-line-map.test.mjs:41:10)",
  "  at Object.<anonymous> (server/core/review-inbox/line-map.mjs:88:5)",
].join("\n");

const boundTask = (over = {}) => ({
  id: "task_abc123",
  reconciliation: "bound",
  evidence: { files: ["server/core/review-inbox/line-map.mjs"] },
  ...over,
});

test("paths come from what the job printed, not from guesses", () => {
  const paths = pathsFromLog(LOG);
  assert.ok(paths.includes("server/core/review-inbox/line-map.mjs"));
  assert.ok(
    paths.some((p) => p.endsWith("tests/review-inbox-line-map.test.mjs")),
  );
});

test("runner and dependency paths are not evidence about this branch", () => {
  const paths = pathsFromLog(
    [
      "at /home/runner/work/_temp/setup.sh:3",
      "at node_modules/express/lib/router.js:12",
      "at server/lib/git.mjs:20",
    ].join("\n"),
  );
  assert.deepEqual(paths, ["server/lib/git.mjs"]);
});

test("toolchain binaries in a Windows trace are not repo evidence", () => {
  const paths = pathsFromLog(
    [
      "C:/Program Files/PowerShell/7/pwsh.EXE",
      "C:/Program Files/Git/bin/git.exe",
      "scripts/self-test.mjs",
    ].join("\n"),
  );
  assert.deepEqual(paths, ["scripts/self-test.mjs"]);
});

test("one bound task sharing a named file is attributed, as likely", () => {
  const r = attributeFailure(FAILURE, { logText: LOG, tasks: [boundTask()] });
  assert.equal(r.attributed, true);
  assert.equal(r.taskId, "task_abc123");
  assert.equal(r.certainty, "likely", "an overlap is not proof of causation");
  assert.deepEqual(r.sharedFiles, ["server/core/review-inbox/line-map.mjs"]);
});

test("an unbound task is never attribution, however well it fits", () => {
  const r = attributeFailure(FAILURE, {
    logText: LOG,
    tasks: [boundTask({ reconciliation: "unknown" })],
  });
  assert.equal(r.attributed, false);
  assert.match(r.reason, /No reliable attribution/);
});

test("two candidate tasks report no attribution, and name both", () => {
  const r = attributeFailure(FAILURE, {
    logText: LOG,
    tasks: [
      boundTask(),
      boundTask({
        id: "task_def456",
        evidence: { files: ["tests/review-inbox-line-map.test.mjs"] },
      }),
    ],
  });
  assert.equal(r.attributed, false);
  assert.deepEqual(r.candidates, ["task_abc123", "task_def456"]);
});

test("a job that named no repo file cannot attribute anything", () => {
  const r = attributeFailure(FAILURE, {
    logText: "Error: connect ETIMEDOUT 10.0.0.1:443",
    tasks: [boundTask()],
  });
  assert.equal(r.attributed, false);
  assert.match(r.reason, /named no file/);
});

test("a task that changed nothing the job named is not attributed", () => {
  const r = attributeFailure(FAILURE, {
    logText: LOG,
    tasks: [boundTask({ evidence: { files: ["README.md"] } })],
  });
  assert.equal(r.attributed, false);
  assert.match(r.reason, /no marker-bound task/);
});

test("a repo-root prefix in the log still matches the repo-relative path", () => {
  const r = attributeFailure(FAILURE, {
    logText: "at D:/a/clawdeck/clawdeck/server/lib/git.mjs:20:9",
    tasks: [boundTask({ evidence: { files: ["server/lib/git.mjs"] } })],
  });
  assert.equal(r.attributed, true);
});
