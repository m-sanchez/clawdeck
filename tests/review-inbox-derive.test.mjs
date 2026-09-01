// @ts-check
/**
 * Display-state derivation. The invariant worth the most here: only the
 * provider can produce REMOTE_RESOLVED, and everything the panel infers is
 * labelled as an inference with the evidence attached.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATES,
  deriveThreadDisplayState,
  summarizeStates,
} from "../server/core/review-inbox/derive.mjs";

const NOW = Date.parse("2026-09-02T12:00:00Z");

const thread = (over = {}) => ({
  id: "rt_abc",
  updatedAt: "2026-09-01T10:00:00Z",
  remoteUrl: "https://example.test/pr/1#note",
  ...over,
  remote: {
    resolved: null,
    resolvable: true,
    outdated: null,
    resolvedBy: null,
    source: "rest",
    ...(over.remote || {}),
  },
});

const facts = (over = {}) => ({
  anchorValid: true,
  fileExists: true,
  fileChanged: false,
  dirty: false,
  mapping: {
    kind: "unchanged-mapped",
    currentLine: 84,
    reasons: ["did not move"],
  },
  blameSha: null,
  reasons: [],
  unknowns: [],
  ...over,
});

test("only the provider can produce REMOTE_RESOLVED", () => {
  const r = deriveThreadDisplayState(
    thread({ remote: { resolved: true, resolvedBy: "sarah" } }),
    null,
    facts(),
    { now: NOW },
  );
  assert.equal(r.state, STATES.REMOTE_RESOLVED);
  assert.equal(r.authority, "forge");
  assert.equal(r.certainty, "known");
});

test("local evidence can reach LIKELY_ADDRESSED but never resolution", () => {
  const r = deriveThreadDisplayState(
    thread({ remote: { resolved: false } }),
    null,
    facts({
      fileChanged: true,
      mapping: {
        kind: "changed",
        currentLine: 90,
        reasons: ["inside a changed range"],
      },
      blameSha: "8bd91f2",
    }),
    { now: NOW },
  );
  assert.equal(r.state, STATES.LIKELY_ADDRESSED);
  assert.equal(r.authority, "clawdeck");
  assert.equal(r.certainty, "likely", "an inference is never 'known'");
  assert.notEqual(r.state, STATES.REMOTE_RESOLVED);
  assert.ok(
    r.reasons.some((x) => /still reports this thread unresolved/.test(x)),
    "the remote fact stays visible next to the inference",
  );
});

test("unknown resolution is recorded as unknown, never as unresolved", () => {
  const r = deriveThreadDisplayState(thread(), null, facts(), { now: NOW });
  assert.ok(r.unknowns.includes("remote-resolution"));
});

test("a changed file with unchanged lines is LOCALLY_CHANGED, not likely addressed", () => {
  const r = deriveThreadDisplayState(
    thread({ remote: { resolved: false } }),
    null,
    facts({ fileChanged: true }),
    { now: NOW },
  );
  assert.equal(r.state, STATES.LOCALLY_CHANGED);
  assert.equal(r.authority, "git");
});

test("a closed change and a provider-outdated thread are both STALE", () => {
  const closed = deriveThreadDisplayState(thread(), null, facts(), {
    now: NOW,
    changeState: "merged",
  });
  assert.equal(closed.state, STATES.STALE);
  const outdated = deriveThreadDisplayState(
    thread({ remote: { outdated: true } }),
    null,
    facts(),
    { now: NOW },
  );
  assert.equal(outdated.state, STATES.STALE);
});

test("a human mark outranks inference; a saved draft outranks a read mark", () => {
  const marked = deriveThreadDisplayState(
    thread({ remote: { resolved: false } }),
    { mark: "needs-human", markAt: "2026-09-02T09:00:00Z" },
    facts({ fileChanged: true, mapping: { kind: "changed", reasons: [] } }),
    { now: NOW },
  );
  assert.equal(marked.state, STATES.NEEDS_HUMAN);
  assert.equal(marked.authority, "human");

  const drafted = deriveThreadDisplayState(
    thread(),
    { draft: { chars: 220 }, lastReadAt: Date.parse("2026-09-02T09:00:00Z") },
    facts(),
    { now: NOW },
  );
  assert.equal(drafted.state, STATES.REPLY_DRAFTED);
  assert.ok(
    drafted.evidence.some((e) => /has not been posted/.test(e.note)),
    "a draft must never imply a posted reply",
  );
});

test("read tracking distinguishes unread, acknowledged and re-opened", () => {
  const unread = deriveThreadDisplayState(thread(), null, facts(), {
    now: NOW,
  });
  assert.equal(unread.state, STATES.UNREAD);

  const ack = deriveThreadDisplayState(
    thread(),
    { lastReadAt: Date.parse("2026-09-01T11:00:00Z") },
    facts(),
    { now: NOW },
  );
  assert.equal(ack.state, STATES.ACKNOWLEDGED);

  const reopened = deriveThreadDisplayState(
    thread({ updatedAt: "2026-09-02T08:00:00Z" }),
    { lastReadAt: Date.parse("2026-09-01T11:00:00Z") },
    facts(),
    { now: NOW },
  );
  assert.equal(
    reopened.state,
    STATES.UNREAD,
    "a newer comment reopens the thread",
  );
});

test("git unknowns survive into the derived state", () => {
  const r = deriveThreadDisplayState(
    thread({ remote: { resolved: false } }),
    null,
    facts({
      anchorValid: null,
      fileChanged: null,
      mapping: null,
      unknowns: ["anchor", "file-changed", "line-level"],
    }),
    { now: NOW },
  );
  for (const u of ["anchor", "file-changed", "line-level"])
    assert.ok(r.unknowns.includes(u));
  assert.notEqual(r.state, STATES.LIKELY_ADDRESSED);
});

test("every derivation carries a reason and a categorical certainty", () => {
  const cases = [
    deriveThreadDisplayState(
      thread({ remote: { resolved: true } }),
      null,
      facts(),
      { now: NOW },
    ),
    deriveThreadDisplayState(thread(), null, facts({ fileChanged: true }), {
      now: NOW,
    }),
    deriveThreadDisplayState(thread(), { mark: "investigating" }, facts(), {
      now: NOW,
    }),
    deriveThreadDisplayState(thread(), null, facts(), { now: NOW }),
  ];
  for (const c of cases) {
    assert.ok(c.reasons.length > 0, `${c.state} must explain itself`);
    assert.ok(["known", "likely", "unknown"].includes(c.certainty));
    assert.equal(
      typeof c.certainty,
      "string",
      "certainty is categorical, never numeric",
    );
  }
});

test("the summary counts unknown resolution apart from resolved", () => {
  const counts = summarizeStates([
    {
      thread: thread({ remote: { resolved: true } }),
      derived: { state: STATES.REMOTE_RESOLVED },
    },
    {
      thread: thread({ remote: { resolved: false } }),
      derived: { state: STATES.LIKELY_ADDRESSED },
    },
    { thread: thread(), derived: { state: STATES.UNREAD } },
  ]);
  assert.equal(counts.total, 3);
  assert.equal(counts.remoteResolved, 1);
  assert.equal(counts.remoteUnresolved, 1);
  assert.equal(counts.resolutionUnknown, 1);
  assert.equal(counts.likelyAddressed, 1);
  assert.equal(counts.unread, 1);
});

const taskFor = (over = {}) => ({
  id: "task_aaaaaaaaaaaa",
  lifecycle: "SETTLED",
  outcome: "CHANGED",
  sessionId: "sess-1234abcd",
  evidence: { files: ["src/auth.ts"], commit: { sha: "8bd91f2" }, tests: [] },
  ...over,
});

test("a running task says work is under way, never that it worked", () => {
  for (const lifecycle of ["CREATED", "STARTING", "RUNNING", "STALLED"]) {
    const r = deriveThreadDisplayState(
      thread({ remote: { resolved: false } }),
      null,
      facts({ fileChanged: true, mapping: { kind: "changed", reasons: [] } }),
      { now: NOW, tasks: [taskFor({ lifecycle, outcome: null })] },
    );
    assert.equal(r.state, STATES.FIX_IN_PROGRESS, lifecycle);
    assert.notEqual(r.state, STATES.LIKELY_ADDRESSED);
  }
});

test("a task waiting to be launched is distinguished from one working", () => {
  const waiting = deriveThreadDisplayState(thread(), null, facts(), {
    now: NOW,
    tasks: [taskFor({ lifecycle: "CREATED", outcome: null, sessionId: null })],
  });
  assert.match(waiting.reasons[0], /waiting to be launched/);
  assert.ok(waiting.evidence.some((e) => /no session bound yet/.test(e.note)));

  const working = deriveThreadDisplayState(thread(), null, facts(), {
    now: NOW,
    tasks: [taskFor({ lifecycle: "RUNNING", outcome: null })],
  });
  assert.match(working.reasons[0], /working on this thread/);
});

test("a settled task that changed code strengthens the inference, not its certainty", () => {
  const r = deriveThreadDisplayState(
    thread({ remote: { resolved: false } }),
    null,
    facts(),
    { now: NOW, tasks: [taskFor()] },
  );
  assert.equal(r.state, STATES.LIKELY_ADDRESSED);
  assert.equal(r.certainty, "likely", "a task result is still an inference");
  assert.ok(r.evidence.some((e) => e.kind === "task"));
  assert.ok(r.evidence.some((e) => /committed in/.test(e.note)));
  assert.ok(
    r.reasons.some((x) => /still reports this thread unresolved/.test(x)),
    "the remote fact stays beside the inference",
  );
});

test("a task that concluded the review does not hold asks for a human", () => {
  const r = deriveThreadDisplayState(
    thread({ remote: { resolved: false } }),
    null,
    facts(),
    { now: NOW, tasks: [taskFor({ outcome: "NO_CHANGE_RECOMMENDED", evidence: { files: [] } })] },
  );
  assert.equal(r.state, STATES.NEEDS_HUMAN);
  assert.equal(r.authority, "clawdeck");
  assert.ok(r.evidence.some((e) => /nothing was replied or resolved/.test(e.note)));
  assert.notEqual(r.state, STATES.LIKELY_ADDRESSED);
});

test("a failed or cancelled task contributes nothing", () => {
  for (const lifecycle of ["FAILED", "CANCELLED"]) {
    const r = deriveThreadDisplayState(thread(), null, facts(), {
      now: NOW,
      tasks: [taskFor({ lifecycle, outcome: null })],
    });
    assert.equal(r.state, STATES.UNREAD, `${lifecycle} must not speak`);
  }
});

test("no task at all leaves the git-only path intact", () => {
  const r = deriveThreadDisplayState(
    thread({ remote: { resolved: false } }),
    null,
    facts({ fileChanged: true, mapping: { kind: "changed", reasons: ["inside a changed range"] } }),
    { now: NOW, tasks: [] },
  );
  assert.equal(r.state, STATES.LIKELY_ADDRESSED);
  assert.equal(r.evidence.some((e) => e.kind === "task"), false);
});
