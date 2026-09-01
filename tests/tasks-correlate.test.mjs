// @ts-check
/**
 * Marker-based session binding.
 *
 * The property that matters when several tasks launch at once: being the only
 * plausible session nearby is not evidence. Only the marker appearing in a
 * transcript binds a task, and everything else stays unknown.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  candidateTranscripts,
  findMarkers,
} from "../server/core/tasks/correlate.mjs";
import { slugForPath } from "../server/adapters/sessions.mjs";
import {
  bindSession,
  makeTask,
  LIFECYCLE,
} from "../server/core/tasks/model.mjs";

const NOW = Date.now();
const MARKER_A = "clawdeck-task:task_aaaaaaaaaaaa:1111111111111111";
const MARKER_B = "clawdeck-task:task_bbbbbbbbbbbb:2222222222222222";

let checkout = "";
let projectDir = "";

const line = (o) => JSON.stringify(o) + "\n";
const userPrompt = (text) => ({
  type: "user",
  timestamp: new Date(NOW).toISOString(),
  message: { role: "user", content: text },
});

function writeSession(sessionId, records, ageMs = 0) {
  const path = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(path, records.map(line).join(""));
  const when = (NOW - ageMs) / 1000;
  utimesSync(path, when, when);
  return path;
}

before(() => {
  checkout = mkdtempSync(join(homedir(), ".clawdeck-correlate-"));
  projectDir = join(homedir(), ".claude", "projects", slugForPath(checkout));
  mkdirSync(projectDir, { recursive: true });

  // The session that actually ran task A.
  writeSession("aaaaaaaa-0000-0000-0000-000000000001", [
    userPrompt(`Clawdeck task task_aaaaaaaaaaaa.\n\nCorrelation: ${MARKER_A}`),
  ]);
  // A session started at the same moment, doing something else entirely.
  writeSession("bbbbbbbb-0000-0000-0000-000000000002", [
    userPrompt("unrelated work, no marker here"),
  ]);
  // An old session carrying a different task's marker.
  writeSession(
    "cccccccc-0000-0000-0000-000000000003",
    [userPrompt(`Correlation: ${MARKER_B}`)],
    30 * 60 * 1000,
  );
});

after(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(checkout, { recursive: true, force: true });
});

test("candidates are bounded by recency, and candidacy is not a binding", () => {
  const found = candidateTranscripts({ checkoutRoot: checkout }, [], {
    now: NOW,
  });
  assert.equal(found.length, 3);

  const narrow = candidateTranscripts({ checkoutRoot: checkout }, [], {
    now: NOW,
    lookbackMs: 60_000,
  });
  assert.equal(narrow.length, 2, "the 30-minute-old transcript falls outside");
});

test("a marker binds only the transcript that contains it", () => {
  const transcripts = candidateTranscripts({ checkoutRoot: checkout }, [], {
    now: NOW,
  });
  const found = findMarkers([MARKER_A, MARKER_B], transcripts);

  assert.equal(found.get(MARKER_A), "aaaaaaaa-0000-0000-0000-000000000001");
  assert.equal(found.get(MARKER_B), "cccccccc-0000-0000-0000-000000000003");
  assert.equal(
    [...found.values()].includes("bbbbbbbb-0000-0000-0000-000000000002"),
    false,
    "a session running at the same time is never bound",
  );
});

test("an unsubmitted task finds nothing and stays unbound", () => {
  const transcripts = candidateTranscripts({ checkoutRoot: checkout }, [], {
    now: NOW,
  });
  const missing = "clawdeck-task:task_dddddddddddd:9999999999999999";
  const found = findMarkers([missing], transcripts);

  assert.equal(found.has(missing), false);

  const task = makeTask({
    id: "task_dddddddddddd",
    source: { kind: "review", id: "rt_x" },
    intent: "fix",
    marker: missing,
    now: NOW,
  });
  assert.equal(task.lifecycle, LIFECYCLE.CREATED);
  assert.equal(task.reconciliation, "unknown");
});

test("binding a found marker starts the task and records the session", () => {
  const transcripts = candidateTranscripts({ checkoutRoot: checkout }, [], {
    now: NOW,
  });
  const sessionId = findMarkers([MARKER_A], transcripts).get(MARKER_A);
  const task = makeTask({
    id: "task_aaaaaaaaaaaa",
    source: { kind: "review", id: "rt_x" },
    intent: "fix",
    marker: MARKER_A,
    now: NOW,
  });

  const bound = bindSession(task, { sessionId, marker: MARKER_A, now: NOW });
  assert.equal(bound.ok, true);
  assert.equal(bound.task.lifecycle, LIFECYCLE.STARTING);
  assert.equal(bound.task.sessionId, sessionId);
  assert.equal(bound.task.reconciliation, "bound");
  assert.equal(
    bound.task.transitions.at(-1).cause,
    "correlation marker observed",
  );
});

test("a marker from another task cannot bind this one", () => {
  const task = makeTask({
    id: "task_aaaaaaaaaaaa",
    source: { kind: "review", id: "rt_x" },
    intent: "fix",
    marker: MARKER_A,
    now: NOW,
  });
  const wrong = bindSession(task, {
    sessionId: "cccccccc-0000-0000-0000-000000000003",
    marker: MARKER_B,
    now: NOW,
  });
  assert.equal(wrong.ok, false);
});

test("no markers to look for means no transcripts are opened", () => {
  const found = findMarkers(
    [],
    candidateTranscripts({ checkoutRoot: checkout }, [], { now: NOW }),
  );
  assert.equal(found.size, 0);
});
