// @ts-check
/**
 * The view model behind the Inbox. Its job is the separation the whole feature
 * rests on: a provider fact, a Clawdeck derivation and a Claude opinion must
 * never arrive as the same kind of row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIERS,
  filterCounts,
  filterItems,
  groupByFile,
  threadRows,
} from "../ui/shared/review-inbox-model.mjs";

const item = (over = {}) => ({
  thread: {
    id: "rt_" + "a".repeat(24),
    author: "sarah",
    location: { file: "src/auth.ts", line: 84 },
    remote: { resolved: false },
    ...(over.thread || {}),
  },
  derived: {
    state: "LIKELY_ADDRESSED",
    authority: "clawdeck",
    certainty: "likely",
    reasons: ["the reviewed range changed after the review"],
    evidence: [{ kind: "git", note: "last touched in", ref: "8bd91f2" }],
    unknowns: [],
    ...(over.derived || {}),
  },
  facts: { fileChanged: true, ...(over.facts || {}) },
});

test("every row carries exactly one known tier", () => {
  const rows = threadRows(item(), {
    kind: "explain",
    answer: "It asks for a constant-time compare.",
  });
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(TIERS.includes(r.tier), `${r.key} has tier ${r.tier}`);
    assert.equal(typeof r.tier, "string");
  }
  assert.deepEqual([...new Set(rows.map((r) => r.tier))].sort(), [
    "derived",
    "fact",
    "model",
  ]);
});

test("a model row cannot exist without an assist result", () => {
  const rows = threadRows(item(), null);
  assert.equal(
    rows.some((r) => r.tier === "model"),
    false,
    "snapshot data alone must never produce a model row",
  );
});

test("the model row is marked advisory and reports what was sent", () => {
  const rows = threadRows(item(), {
    kind: "draft-pushback",
    answer: "I don't think removing the cache is right.",
    contextChars: 4200,
  });
  const model = rows.find((r) => r.tier === "model");
  assert.equal(model.advisory, true);
  assert.equal(model.contextChars, 4200);
});

test("a derived row always carries its evidence and its certainty", () => {
  const rows = threadRows(item());
  const derived = rows.filter((r) => r.tier === "derived");
  assert.ok(derived.length > 0);
  for (const r of derived) {
    assert.ok(
      Array.isArray(r.evidence) && r.evidence.length > 0,
      `${r.key} needs a Why?`,
    );
    assert.ok(["known", "likely", "unknown"].includes(r.certainty));
  }
});

test("an inference is labelled likely, never presented as resolved", () => {
  const rows = threadRows(item());
  const state = rows.find((r) => r.key === "state");
  assert.equal(state.certainty, "likely");
  assert.equal(state.label, "Likely addressed");

  const remote = rows.find((r) => r.key === "remote");
  assert.equal(remote.tier, "fact");
  assert.equal(
    remote.value,
    "unresolved",
    "the remote fact stays visible alongside",
  );
});

test("unknown resolution reads as unknown, not as unresolved", () => {
  const rows = threadRows(item({ thread: { remote: { resolved: null } } }));
  const remote = rows.find((r) => r.key === "remote");
  assert.equal(remote.value, "resolution unknown");
  assert.match(remote.detail, /did not report/);
});

test("git unknowns surface as their own derived rows", () => {
  const rows = threadRows(
    item({ derived: { unknowns: ["line-level", "anchor"] } }),
  );
  const unknownRows = rows.filter((r) => r.key.startsWith("unknown:"));
  assert.equal(unknownRows.length, 2);
  for (const r of unknownRows) assert.equal(r.certainty, "unknown");
});

test("threads group by file, changed files first", () => {
  const groups = groupByFile([
    item({
      thread: { location: { file: "z.ts", line: 3 } },
      facts: { fileChanged: false },
    }),
    item({
      thread: { location: { file: "a.ts", line: 9 } },
      facts: { fileChanged: true },
    }),
    item({
      thread: { location: { file: "a.ts", line: 2 } },
      facts: { fileChanged: true },
    }),
  ]);
  assert.equal(groups[0].file, "a.ts");
  assert.equal(groups[0].changed, true);
  assert.deepEqual(
    groups[0].items.map((i) => i.thread.location.line),
    [2, 9],
  );
});

test("filters separate unresolved, blocking, changed and unknown", () => {
  const items = [
    item({
      thread: { remote: { resolved: true } },
      facts: { fileChanged: false },
    }),
    item({ thread: { remote: { resolved: false } } }),
    item({
      thread: { remote: { resolved: null } },
      derived: { unknowns: ["line-level"] },
    }),
  ];
  const counts = filterCounts(items);
  assert.equal(counts.all, 3);
  assert.equal(counts.unresolved, 2, "unknown resolution is not resolved");
  assert.equal(
    counts.blocking,
    1,
    "only a reported false is a blocking thread",
  );
  assert.equal(counts.unknown, 1);
  assert.equal(filterItems(items, "blocking").length, 1);
});
