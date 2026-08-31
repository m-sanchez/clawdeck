// @ts-check
/** Unit tests for the pure hub/tab route resolver. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRoute, canonicalHash } from "../ui/lib/route.mjs";

const CFG = {
  fallback: "overview",
  hubs: {
    overview: {},
    activity: { tabs: ["timeline", "logs"] },
    run: { tabs: ["runs", "commands"] },
    worktrees: {},
    review: { tabs: ["diff", "validation", "reviews", "mr"] },
    data: { tabs: ["finder", "console", "inspector"] },
    prompt: {},
    config: {},
  },
  aliases: {
    runs: "run/runs",
    commands: "run/commands",
    timeline: "activity/timeline",
    logs: "activity/logs",
    validation: "review/validation",
    reviews: "review/reviews",
    diff: "review/diff",
    mr: "review/mr",
    "data-finder": "data/finder",
    console: "data/console",
    inspector: "data/inspector",
  },
};
const r = (hash) => resolveRoute(hash, CFG);

test("empty hash falls back to the default hub", () => {
  assert.deepEqual(r(""), {
    hub: "overview",
    tab: null,
    id: null,
    explicitTab: false,
  });
});

test("unknown hub falls back to the default", () => {
  assert.equal(r("nope").hub, "overview");
});

test("bare tabbed hub defaults to its first tab, not explicit", () => {
  assert.deepEqual(r("review"), {
    hub: "review",
    tab: "diff",
    id: null,
    explicitTab: false,
  });
});

test("explicit tab is marked explicit", () => {
  assert.deepEqual(r("review/reviews"), {
    hub: "review",
    tab: "reviews",
    id: null,
    explicitTab: true,
  });
});

test("invalid tab segment defaults to first tab, not explicit", () => {
  assert.deepEqual(r("data/bogus"), {
    hub: "data",
    tab: "finder",
    id: null,
    explicitTab: false,
  });
});

test("alias expands an old single-route link to its hub/tab", () => {
  assert.deepEqual(r("reviews"), {
    hub: "review",
    tab: "reviews",
    id: null,
    explicitTab: true,
  });
});

test("alias preserves a trailing id (run detail)", () => {
  assert.deepEqual(r("runs/job-123"), {
    hub: "run",
    tab: "runs",
    id: "job-123",
    explicitTab: true,
  });
});

test("explicit run detail id is captured", () => {
  assert.equal(r("run/runs/abc").id, "abc");
});

test("non-tabbed hub captures an id from the second segment", () => {
  assert.deepEqual(r("worktrees/x"), {
    hub: "worktrees",
    tab: null,
    id: "x",
    explicitTab: false,
  });
});

test("ids are percent-decoded", () => {
  assert.equal(r("run/runs/a%2Fb").id, "a/b");
});

test("canonicalHash builds tabbed, detail, and single forms", () => {
  assert.equal(canonicalHash("review", "diff", null, true), "#/review/diff");
  assert.equal(canonicalHash("run", "runs", "abc", true), "#/run/runs/abc");
  assert.equal(canonicalHash("worktrees", null, null, false), "#/worktrees");
  assert.equal(canonicalHash("worktrees", null, "x", false), "#/worktrees/x");
});
