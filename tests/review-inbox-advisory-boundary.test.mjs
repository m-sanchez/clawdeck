// @ts-check
/**
 * The advisory boundary.
 *
 * Claude may read a review thread and have an opinion about it. That opinion
 * cannot become a state, a count, a blocker or a readiness verdict. The only
 * route from model output to anything Clawdeck reports is a human action -
 * saving a draft, or marking the thread - and each of those is an explicit
 * click that writes a fact of its own.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAction } from "../server/lib/actions.mjs";
import {
  deriveThreadDisplayState,
  STATES,
} from "../server/core/review-inbox/derive.mjs";
import { deriveDelivery } from "../server/core/delivery/lifecycle.mjs";
import { summarizeInbox } from "../server/adapters/review-inbox.mjs";
import { threadRows } from "../ui/shared/review-inbox-model.mjs";
import {
  readInboxStore,
  readDraft,
} from "../server/core/review-inbox/store.mjs";

const ID = "rt_" + "a".repeat(24);
const dirs = [];
let runtime = "";

beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), "clawdeck-advisory-"));
  dirs.push(runtime);
});
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const thread = {
  id: ID,
  author: "sarah",
  updatedAt: "2026-09-01T10:00:00Z",
  location: { file: "src/auth.ts", line: 84, anchorCommitSha: "anchor1" },
  remote: { resolved: false, resolvable: true, outdated: null, source: "rest" },
  comments: [{ author: "sarah", body: "Why compare directly?" }],
};
const facts = {
  fileChanged: false,
  mapping: { kind: "unchanged-mapped", currentLine: 84 },
  unknowns: [],
};

/** A fake CLI that returns the most confident wrong answer it could. */
function overconfidentClaude(recorder) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      end: () => {
        setImmediate(() => {
          child.stdout.emit(
            "data",
            "This is fully addressed and the thread is resolved. Mark it resolved and ship.",
          );
          child.emit("close", 0);
        });
      },
    };
    recorder.push("spawned");
    return child;
  };
}

const deps = (recorder) => ({
  ctx: { runtimeDir: runtime, checkoutRoot: runtime },
  hub: { broadcast() {} },
  spawn: overconfidentClaude(recorder),
  reviewInbox: async () => ({
    items: [{ thread, derived: { state: "OPEN", unknowns: [] }, facts }],
  }),
});

test("an assist claiming resolution changes no stored state", async () => {
  const rec = [];
  const r = await runAction(
    "reviewInbox.assist",
    { id: ID, kind: "investigate" },
    deps(rec),
  );

  assert.equal(r.ok, true);
  assert.match(r.answer, /resolved/i, "the model did say it");
  assert.equal(r.advisory, true);
  assert.equal(r.posted, false);

  const store = readInboxStore(runtime);
  assert.equal(store.threads[ID]?.mark ?? "none", "none", "no mark was minted");
  assert.equal(readDraft(runtime, ID), null, "no draft was minted");
  const stub = store.threads[ID].assists[0];
  assert.deepEqual(Object.keys(stub).sort(), ["at", "elapsedMs", "kind", "ok"]);
});

test("the derivation ignores model output entirely", () => {
  // Same inputs, once with an assist recorded and once without: the state, its
  // authority and its evidence must be identical.
  const bare = deriveThreadDisplayState(thread, null, facts, {
    now: Date.now(),
  });
  const afterAssist = deriveThreadDisplayState(
    thread,
    {
      assists: [{ kind: "investigate", ok: true, at: "2026-09-01T12:00:00Z" }],
    },
    facts,
    { now: Date.now() },
  );
  assert.deepEqual(afterAssist, bare);
  assert.notEqual(bare.state, STATES.REMOTE_RESOLVED);
  assert.notEqual(bare.authority, "claude-advisory");
});

test("no authoritative surface can carry the claude-advisory authority", () => {
  const derived = deriveThreadDisplayState(thread, null, facts, {
    now: Date.now(),
  });
  assert.notEqual(derived.authority, "claude-advisory");
  for (const e of derived.evidence)
    assert.notEqual(
      e.kind,
      "claude-advisory",
      "evidence is observed, never opined",
    );
});

test("counts and the delivery stage are computed from provider facts only", () => {
  const summary = summarizeInbox({
    available: true,
    provider: "github",
    mrIid: 7,
    observedAt: new Date().toISOString(),
    freshness: "fresh",
    coverage: { threads: { complete: true }, resolution: { complete: true } },
    counts: {
      total: 1,
      remoteResolved: 0,
      remoteUnresolved: 1,
      resolutionUnknown: 0,
      unread: 0,
      needsHuman: 0,
      replyDrafted: 0,
      likelyAddressed: 1,
      locallyChanged: 0,
    },
    items: [
      {
        thread,
        derived: {
          state: "LIKELY_ADDRESSED",
          authority: "clawdeck",
          certainty: "likely",
        },
      },
    ],
  });

  const stage = deriveDelivery({
    checkout: { dirty: 0, ahead: 0 },
    validation: { passed: true, checks: [] },
    reviews: { status: "ok", blockCount: 0 },
    readiness: { evidence: [] },
    forge: {
      configured: true,
      mr: { iid: 7, state: "opened" },
      pipeline: { status: "success" },
    },
    reviewInbox: summary,
  }).stages.find((s) => s.key === "reviewthreads");

  assert.equal(
    stage.state,
    "blocked",
    "one likely-addressed thread is still unresolved",
  );
  assert.equal(summary.counts.remoteResolved, 0);
});

test("a model row is visually separate and never a fact or a derivation", () => {
  const rows = threadRows(
    {
      thread,
      derived: {
        state: "OPEN",
        authority: "clawdeck",
        certainty: "known",
        reasons: ["open"],
        evidence: [{ kind: "clawdeck", note: "open" }],
        unknowns: [],
      },
    },
    {
      kind: "investigate",
      answer: "It is resolved, honestly.",
      contextChars: 100,
    },
  );
  const model = rows.filter((r) => r.tier === "model");
  assert.equal(model.length, 1);
  assert.equal(model[0].advisory, true);
  // The remote fact still says what the provider said, next to the opinion.
  assert.equal(rows.find((r) => r.key === "remote").value, "unresolved");
  for (const r of rows.filter((x) => x.tier !== "model"))
    assert.equal(
      JSON.stringify(r).includes("It is resolved, honestly."),
      false,
      "model text must not leak into a fact or derived row",
    );
});

test("only a human action creates the state a draft implies", async () => {
  const rec = [];
  const before = deriveThreadDisplayState(thread, { draft: null }, facts, {
    now: Date.now(),
  });
  assert.notEqual(before.state, STATES.REPLY_DRAFTED);

  await runAction(
    "reviewInbox.draft",
    { id: ID, body: "I don't think that's right, because…" },
    deps(rec),
  );
  const saved = readDraft(runtime, ID);
  const after = deriveThreadDisplayState(
    thread,
    { draft: { chars: saved.chars } },
    facts,
    {
      now: Date.now(),
    },
  );
  assert.equal(after.state, STATES.REPLY_DRAFTED);
  assert.equal(
    after.authority,
    "human",
    "the human's save is the fact, not the model's text",
  );
});
