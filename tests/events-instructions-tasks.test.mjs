// @ts-check
/**
 * InstructionsLoaded observability + task lifecycle. Both are privacy-safe:
 * instruction content and task subject/description/teammate/team are NEVER
 * persisted; only paths, small enums, ids, and timestamps. Uses the REAL runtime
 * payload shapes (file_path/memory_type/load_reason/globs/trigger_file_path/
 * parent_file_path; task_id + event type), not a fabricated content/status field.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { applyEvent } from "../server/core/events/projection.mjs";
import { getInstructionBudget } from "../server/adapters/instruction-budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const normalize = require_(
  path.join(here, "..", "hooks", "lib", "event-normalize.cjs"),
);

// ── InstructionsLoaded normalization (real payload, no content) ──

test("InstructionsLoaded normalizes real metadata (path/memoryType/reason/globs/trigger/parent), never content", () => {
  const evt = normalize.normalizeEvent(
    {
      hook_event_name: "InstructionsLoaded",
      session_id: "s1",
      cwd: "/repo",
      file_path: "/repo/.claude/rules/angular.md",
      memory_type: "project",
      load_reason: "path_glob_match",
      globs: ["client/src/**"],
      trigger_file_path: "/repo/client/src/app/x.ts",
      parent_file_path: "/repo/CLAUDE.md",
      // Even if some rogue content-ish field appears, it must never be read.
      file_content: "SHOULD_NOT_APPEAR_secret_body",
    },
    { id: "e1", ts: 100 },
  );
  assert.equal(evt.event, "instructions.loaded");
  assert.equal(evt.session_id, "s1");
  assert.equal(evt.data.file, "/repo/.claude/rules/angular.md");
  assert.equal(evt.data.memoryType, "project");
  assert.equal(evt.data.loadReason, "path_glob_match");
  assert.deepEqual(evt.data.globs, ["client/src/**"]);
  assert.equal(evt.data.triggerFilePath, "/repo/client/src/app/x.ts");
  assert.equal(evt.data.parentFilePath, "/repo/CLAUDE.md");
  assert.ok(!("bytes" in evt.data), "no fabricated byte size from content");
  assert.ok(
    !JSON.stringify(evt).includes("SHOULD_NOT_APPEAR"),
    "no instruction content is ever persisted",
  );
});

test("InstructionsLoaded handles missing optional fields safely", () => {
  const evt = normalize.normalizeEvent(
    {
      hook_event_name: "InstructionsLoaded",
      session_id: "s1",
      file_path: "/repo/CLAUDE.md",
      load_reason: "session_start",
    },
    { id: "e1", ts: 100 },
  );
  assert.equal(evt.data.file, "/repo/CLAUDE.md");
  assert.equal(evt.data.loadReason, "session_start");
  assert.equal(evt.data.memoryType, null);
  assert.equal(evt.data.globs, null);
  assert.equal(evt.data.triggerFilePath, null);
  assert.equal(evt.data.parentFilePath, null);
});

// ── InstructionsLoaded projection (order-independent metadata high-water) ──

const load = (m, ts, extra) =>
  applyEvent(m, {
    session_id: "s",
    event: "instructions.loaded",
    ts,
    data: { file: "/r/CLAUDE.md", ...extra },
  });

test("latest metadata follows the newest ts, not delivery order", () => {
  const build = (order) => {
    const m = new Map();
    for (const e of order) load(m, e.ts, e.data);
    return m.get("s").instructions["/r/CLAUDE.md"];
  };
  const older = {
    ts: 100,
    data: { loadReason: "session_start", memoryType: "project" },
  };
  const newer = {
    ts: 200,
    data: { loadReason: "compact", memoryType: "project" },
  };
  const a = build([newer, older]); // newer delivered first
  const b = build([older, newer]); // older delivered first
  assert.equal(a.loadReason, "compact", "newer metadata wins");
  assert.equal(b.loadReason, "compact", "same result under reversed delivery");
  for (const r of [a, b]) {
    assert.equal(r.firstAt, 100);
    assert.equal(r.lastAt, 200);
    assert.equal(r.loads, 2);
  }
});

test("an exact metadata-timestamp tie is deterministic + order-independent", () => {
  const build = (order) => {
    const m = new Map();
    for (const reason of order) load(m, 100, { loadReason: reason });
    return m.get("s").instructions["/r/CLAUDE.md"].loadReason;
  };
  assert.equal(
    build(["compact", "session_start"]),
    build(["session_start", "compact"]),
    "equal-ts tie must not depend on delivery order",
  );
});

test("a repeated load is idempotent for metadata and bumps the counter", () => {
  const m = new Map();
  load(m, 100, { loadReason: "session_start" });
  load(m, 100, { loadReason: "session_start" });
  const r = m.get("s").instructions["/r/CLAUDE.md"];
  assert.equal(r.loads, 2);
  assert.equal(r.loadReason, "session_start");
});

test("multiple instruction files project independently", () => {
  const m = new Map();
  applyEvent(m, {
    session_id: "s",
    event: "instructions.loaded",
    ts: 1,
    data: { file: "/a", loadReason: "session_start" },
  });
  applyEvent(m, {
    session_id: "s",
    event: "instructions.loaded",
    ts: 2,
    data: { file: "/b", loadReason: "path_glob_match" },
  });
  const s = m.get("s");
  assert.equal(Object.keys(s.instructions).length, 2);
  assert.equal(s.instructions["/a"].loadReason, "session_start");
  assert.equal(s.instructions["/b"].loadReason, "path_glob_match");
});

// ── Instruction Budget baseline classification (FIX 2) ──

test("getInstructionBudget: unconditional rules are baseline, path-scoped are on-demand", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ib-"));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# root\n" + "x".repeat(100));
  const rulesDir = path.join(root, ".claude", "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  // Unconditional (no paths frontmatter) -> baseline.
  fs.writeFileSync(
    path.join(rulesDir, "style.md"),
    "# Style\n" + "y".repeat(50),
  );
  fs.writeFileSync(
    path.join(rulesDir, "testing.md"),
    "# Testing\n" + "z".repeat(40),
  );
  // Path-scoped (paths frontmatter) -> conditional.
  fs.writeFileSync(
    path.join(rulesDir, "angular.md"),
    '---\npaths:\n  - "client/src/**"\n---\n# Angular\n' + "a".repeat(30),
  );
  fs.writeFileSync(
    path.join(rulesDir, "mongo.md"),
    '---\npaths:\n  - "server/src/**"\n---\n# Mongo\n' + "b".repeat(20),
  );
  const ib = getInstructionBudget({ checkoutRoot: root });
  const baseline = ib.alwaysLoaded.map((e) => e.path).sort();
  assert.deepEqual(baseline, [
    ".claude/rules/style.md",
    ".claude/rules/testing.md",
    "CLAUDE.md",
  ]);
  assert.ok(
    !baseline.includes(".claude/rules/angular.md"),
    "path-scoped is not baseline",
  );
  const pathScoped = ib.onDemand.find(
    (d) => d.path === ".claude/rules (path-scoped)",
  );
  assert.equal(pathScoped.files, 2, "two path-scoped rules on-demand");
  assert.equal(ib.estimated, true, "sizes are labelled estimated");
  const claudeChars = fs.readFileSync(
    path.join(root, "CLAUDE.md"),
    "utf8",
  ).length;
  assert.ok(
    ib.totalChars > claudeChars,
    "baseline total includes the unconditional rules, not just CLAUDE.md",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Task lifecycle (task_id + event type; no fabricated status/content) ──

test("Task events promote task_id and persist NO content or status", () => {
  const created = normalize.normalizeEvent(
    {
      hook_event_name: "TaskCreated",
      session_id: "s1",
      task_id: "T-1",
      task_subject: "Refactor the auth flow",
      task_description: "long user description that must not persist",
      teammate_name: "alice",
      team_name: "platform",
    },
    { id: "e1", ts: 100 },
  );
  assert.equal(created.event, "task.created");
  assert.equal(created.task_id, "T-1");
  assert.deepEqual(created.data, {}, "no status/subject/description/names");
  const s = JSON.stringify(created);
  for (const leak of [
    "Refactor the auth flow",
    "must not persist",
    "alice",
    "platform",
  ])
    assert.ok(!s.includes(leak), `must not persist: ${leak}`);

  const done = normalize.normalizeEvent(
    {
      hook_event_name: "TaskCompleted",
      session_id: "s1",
      task_id: "T-1",
      task_subject: "Refactor the auth flow",
    },
    { id: "e2", ts: 200 },
  );
  assert.equal(done.event, "task.completed");
  assert.equal(done.task_id, "T-1");
  assert.deepEqual(done.data, {});
});

test("a task correlates created+completed by task_id; completion is the event type", () => {
  const m = new Map();
  applyEvent(m, {
    session_id: "s1",
    event: "task.created",
    ts: 100,
    task_id: "T-1",
  });
  applyEvent(m, {
    session_id: "s1",
    event: "task.completed",
    ts: 200,
    task_id: "T-1",
  });
  const s = m.get("s1");
  assert.equal(s.tasksCreated, 1);
  assert.equal(s.tasksCompleted, 1);
  assert.equal(s.tasks["T-1"].createdAt, 100);
  assert.equal(s.tasks["T-1"].completedAt, 200);
  assert.equal(s.tasks["T-1"].completed, true);
  assert.ok(!("status" in s.tasks["T-1"]), "no fabricated status field");
});

test("task correlation is order-independent and duplicate-id idempotent", () => {
  const m = new Map();
  applyEvent(m, {
    session_id: "s",
    event: "task.completed",
    ts: 200,
    task_id: "T",
  });
  applyEvent(m, {
    session_id: "s",
    event: "task.created",
    ts: 100,
    task_id: "T",
  });
  applyEvent(m, {
    session_id: "s",
    event: "task.created",
    ts: 150,
    task_id: "T",
  });
  const s = m.get("s");
  assert.equal(s.tasksCreated, 1, "same task_id collapses to one");
  assert.equal(s.tasksCompleted, 1);
  assert.equal(s.tasks["T"].createdAt, 100, "earliest created wins");
  assert.equal(s.tasks["T"].completedAt, 200);
});

test("multiple tasks are counted distinctly", () => {
  const m = new Map();
  applyEvent(m, {
    session_id: "s",
    event: "task.created",
    ts: 100,
    task_id: "A",
  });
  applyEvent(m, {
    session_id: "s",
    event: "task.created",
    ts: 110,
    task_id: "B",
  });
  applyEvent(m, {
    session_id: "s",
    event: "task.completed",
    ts: 200,
    task_id: "A",
  });
  const s = m.get("s");
  assert.equal(s.tasksCreated, 2);
  assert.equal(s.tasksCompleted, 1);
});

test("id-less task events fall back to counters without phantom task entries", () => {
  const m = new Map();
  applyEvent(m, { session_id: "s", event: "task.created", ts: 100 });
  applyEvent(m, { session_id: "s", event: "task.completed", ts: 200 });
  const s = m.get("s");
  assert.equal(s.tasksCreated, 1);
  assert.equal(s.tasksCompleted, 1);
  assert.deepEqual(s.tasks, {}, "no fabricated task_id keys");
});

test("a completion at ts<=0 still counts (explicit completed flag)", () => {
  const m = new Map();
  applyEvent(m, {
    session_id: "s",
    event: "task.created",
    ts: 0,
    task_id: "T",
  });
  applyEvent(m, {
    session_id: "s",
    event: "task.completed",
    ts: 0,
    task_id: "T",
  });
  const s = m.get("s");
  assert.equal(s.tasksCreated, 1);
  assert.equal(s.tasksCompleted, 1, "a ts=0 completion still counts as done");
  assert.equal(s.tasks["T"].completed, true);
});

// ── Observed instruction rollup: order-independent + real, not estimated ──

/** Observed rollup only depends on `events`; the checkoutRoot is irrelevant. */
function observedFor(sessions) {
  return getInstructionBudget({ checkoutRoot: os.tmpdir() }, { sessions })
    .observed;
}

test("observed rollup is identical regardless of session iteration order on an exact-timestamp tie", () => {
  const file = "/r/CLAUDE.md";
  const sesA = {
    instructions: {
      [file]: {
        loads: 1,
        lastAt: 500,
        loadReason: "session_start",
        memoryType: "project",
      },
    },
  };
  const sesB = {
    instructions: {
      [file]: {
        loads: 1,
        lastAt: 500,
        loadReason: "compact",
        memoryType: "project",
      },
    },
  };
  const ab = observedFor([sesA, sesB]);
  const ba = observedFor([sesB, sesA]);
  assert.deepEqual(
    ab,
    ba,
    "same multiset, identical rollup regardless of order",
  );
  const f = ab.files.find((x) => x.file === file);
  assert.equal(f.loads, 2);
  assert.equal(f.sessions, 2);
  assert.equal(f.lastAt, 500);
});

test("observed rollup: newer timestamp wins the metadata in either order", () => {
  const file = "/r/CLAUDE.md";
  const older = {
    instructions: {
      [file]: {
        loads: 1,
        lastAt: 100,
        loadReason: "session_start",
        memoryType: "project",
      },
    },
  };
  const newer = {
    instructions: {
      [file]: {
        loads: 1,
        lastAt: 200,
        loadReason: "compact",
        memoryType: "user",
      },
    },
  };
  for (const order of [
    [older, newer],
    [newer, older],
  ]) {
    const f = observedFor(order).files.find((x) => x.file === file);
    assert.equal(f.lastAt, 200);
    assert.equal(f.loadReason, "compact", "newer metadata wins");
    assert.equal(f.memoryType, "user");
  }
});

test("observed rollup: exact timestamp + identical metadata is idempotent", () => {
  const file = "/r/CLAUDE.md";
  const rec = {
    loads: 1,
    lastAt: 300,
    loadReason: "session_start",
    memoryType: "project",
  };
  const f = observedFor([
    { instructions: { [file]: { ...rec } } },
    { instructions: { [file]: { ...rec } } },
  ]).files.find((x) => x.file === file);
  assert.equal(f.loadReason, "session_start");
  assert.equal(f.memoryType, "project");
  assert.equal(f.lastAt, 300);
  assert.equal(f.loads, 2);
});

test("observed instruction evidence is real runtime data, not an estimate", () => {
  const ib = getInstructionBudget(
    { checkoutRoot: os.tmpdir() },
    {
      sessions: [
        {
          instructions: {
            "/r/CLAUDE.md": {
              loads: 1,
              lastAt: 100,
              loadReason: "session_start",
              memoryType: "project",
            },
          },
        },
      ],
    },
  );
  // The static filesystem/token budget stays an explicit estimate...
  assert.equal(ib.estimated, true, "static budget is labelled estimated");
  // ...but observed InstructionsLoaded evidence is not an estimate and carries
  // no fabricated size.
  assert.ok(
    !("estimated" in ib.observed),
    "observed events are evidence, not an estimate",
  );
  assert.equal(ib.observed.source, "InstructionsLoaded hook events");
  const f = ib.observed.files[0];
  assert.ok(
    !("bytes" in f) && !("chars" in f) && !("estTokens" in f),
    "observed evidence has no fabricated size",
  );
});
