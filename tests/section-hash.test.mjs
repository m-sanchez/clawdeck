// @ts-check
/**
 * Section hashing: per-key change isolation, volatile-key exclusion, and the
 * property the ETag depends on - two idle builds of the real snapshot yield
 * the same version.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fnv1a, sectionHashes } from "../server/lib/section-hash.mjs";
import { buildSnapshot } from "../server/lib/snapshot.mjs";

const BASE = {
  checkout: { id: "x", branch: "main" },
  runs: [{ id: 1 }],
  cost: { rollup: { usd: 1 } },
  emittedAt: "2026-09-01T00:00:00.000Z",
  panel: { uptimeSec: 10 },
  perf: { snapshot: { p50: 3 } },
};

test("fnv1a is deterministic 8-hex and input-sensitive", () => {
  assert.match(fnv1a("abc"), /^[0-9a-f]{8}$/);
  assert.equal(fnv1a("abc"), fnv1a("abc"));
  assert.notEqual(fnv1a("abc"), fnv1a("abd"));
});

test("a change in one section moves only that hash (and the version)", () => {
  const a = sectionHashes(BASE);
  const b = sectionHashes({ ...BASE, cost: { rollup: { usd: 2 } } });
  assert.notEqual(a.byKey.cost, b.byKey.cost);
  assert.equal(a.byKey.runs, b.byKey.runs);
  assert.equal(a.byKey.checkout, b.byKey.checkout);
  assert.notEqual(a.version, b.version);
});

test("volatile sections are unhashed and do not move the version", () => {
  const a = sectionHashes(BASE);
  const b = sectionHashes({
    ...BASE,
    emittedAt: "2026-09-01T00:00:09.000Z",
    panel: { uptimeSec: 99 },
    perf: { snapshot: { p50: 8 } },
  });
  assert.equal(a.version, b.version);
  for (const k of ["emittedAt", "panel", "perf", "history", "sections"])
    assert.equal(k in a.byKey, false, `${k} must not be hashed`);
});

test("restamping a snapshot that already carries sections is idempotent", () => {
  const first = sectionHashes(BASE);
  const second = sectionHashes({ ...BASE, sections: first });
  assert.deepEqual(second, first);
});

test("two idle builds of the real snapshot agree on the version", async () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "sect-co-"));
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "sect-rt-"));
  try {
    const ctx = {
      checkoutId: "sect-test",
      checkoutRoot: checkout,
      repoRoot: checkout,
      runtimeDir: runtime,
      panelRoot: checkout,
    };
    const cached = {
      reviews: { status: "pending", findings: [], blockCount: 0, warnCount: 0 },
      validation: { status: "none", checks: [], passed: false, ranAt: null },
    };
    const one = await buildSnapshot(ctx, cached);
    const two = await buildSnapshot(ctx, cached);
    assert.match(one.sections.version, /^[0-9a-f]{8}$/);
    for (const key of Object.keys(one.sections.byKey))
      assert.equal(
        two.sections.byKey[key],
        one.sections.byKey[key],
        `section "${key}" must be stable across idle builds`,
      );
    assert.equal(two.sections.version, one.sections.version);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});
