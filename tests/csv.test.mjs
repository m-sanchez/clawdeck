// @ts-check
/** Unit tests for the CSV export helpers. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv, isRowArray } from "../ui/lib/csv.mjs";

test("toCsv emits a header from the union of keys, in first-seen order", () => {
  const csv = toCsv([
    { a: 1, b: 2 },
    { a: 3, c: 4 },
  ]);
  const [head, ...rows] = csv.split("\n");
  assert.equal(head, "a,b,c");
  assert.equal(rows[0], "1,2,");
  assert.equal(rows[1], "3,,4");
});

test("toCsv quotes values with commas, quotes, or newlines (RFC-4180)", () => {
  const csv = toCsv([{ x: "a,b", y: 'he said "hi"', z: "line1\nline2" }]);
  const row = csv.split("\n").slice(1).join("\n");
  assert.ok(row.includes('"a,b"'));
  assert.ok(row.includes('"he said ""hi"""'));
  assert.ok(row.includes('"line1\nline2"'));
});

test("toCsv renders null/undefined as empty and objects as JSON", () => {
  const csv = toCsv([{ a: null, b: undefined, c: { k: 1 } }]);
  const row = csv.split("\n")[1];
  // c is an object → JSON.stringify → contains a comma? no, {"k":1} has none.
  assert.equal(row, ',,"{""k"":1}"');
});

test("isRowArray accepts arrays of plain objects only", () => {
  assert.equal(isRowArray([{ a: 1 }]), true);
  assert.equal(isRowArray([]), false);
  assert.equal(isRowArray([1, 2, 3]), false);
  assert.equal(isRowArray([{ a: 1 }, [2]]), false);
  assert.equal(isRowArray(null), false);
  assert.equal(isRowArray({ a: 1 }), false);
});
