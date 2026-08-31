// @ts-check
// The quota-pressure contract: one sample, no mixing, absence is unknown.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeQuotaPressure,
  QUOTA_TTL_MS,
  QUOTA_SOURCE,
} from "../server/core/telemetry/quota-pressure.mjs";

const NOW = 1_800_000_000_000; // fixed clock; nothing here reads the real one
const rec = (ts, rateLimits) => ({ ts, rateLimits });

test("no sessions at all reads unknown, not zero", () => {
  for (const input of [undefined, null, {}, []]) {
    const q = computeQuotaPressure(input, NOW);
    assert.equal(q.band, "unknown");
    assert.equal(q.stale, false, "absence is not staleness");
    assert.equal(q.fiveHourPct, null);
    assert.equal(q.sevenDayPct, null);
    assert.equal(q.sampledAt, null);
    assert.equal(q.source, QUOTA_SOURCE);
  }
});

test("a session without rate limits is not a sample", () => {
  const q = computeQuotaPressure(
    { a: { ts: NOW, costUsd: 3 }, b: { ts: NOW, rateLimits: {} } },
    NOW,
  );
  assert.equal(q.band, "unknown");
  assert.equal(q.sampledAt, null);
});

test("one window present is enough, and the other stays null", () => {
  const q = computeQuotaPressure({ a: rec(NOW, { fiveHourPct: 42 }) }, NOW);
  assert.equal(q.fiveHourPct, 42);
  assert.equal(q.sevenDayPct, null);
  assert.equal(q.band, "green");
  assert.equal(q.stale, false);
  assert.equal(q.sampledAt, NOW);
});

test("both windows present band to the worse of the two", () => {
  const q = computeQuotaPressure(
    { a: rec(NOW, { fiveHourPct: 12, sevenDayPct: 91 }) },
    NOW,
  );
  assert.equal(q.band, "red");
  const amber = computeQuotaPressure(
    { a: rec(NOW, { fiveHourPct: 70, sevenDayPct: 10 }) },
    NOW,
  );
  assert.equal(amber.band, "amber");
});

test("a stale sample is reported but never banded", () => {
  const old = NOW - QUOTA_TTL_MS - 1;
  const q = computeQuotaPressure({ a: rec(old, { fiveHourPct: 95 }) }, NOW);
  assert.equal(q.stale, true);
  assert.equal(q.fiveHourPct, 95, "the reading is still shown");
  assert.equal(q.band, "unknown", "a stale reading must not drive a band");
  // A future-dated sample is just as untrustworthy.
  const future = computeQuotaPressure(
    { a: rec(NOW + 60_000, { fiveHourPct: 95 }) },
    NOW,
  );
  assert.equal(future.stale, true);
  assert.equal(future.band, "unknown");
});

test("with several sessions the newest sample wins and windows never mix", () => {
  const q = computeQuotaPressure(
    {
      old: rec(NOW - 60_000, { fiveHourPct: 10, sevenDayPct: 99 }),
      newest: rec(NOW - 1_000, { fiveHourPct: 55 }),
      older: rec(NOW - 120_000, { sevenDayPct: 80 }),
    },
    NOW,
  );
  assert.equal(q.sampledAt, NOW - 1_000);
  assert.equal(q.fiveHourPct, 55);
  assert.equal(
    q.sevenDayPct,
    null,
    "a 7d value from another sample must not be borrowed",
  );
  assert.equal(q.band, "green");
});

test("invalid percentages fall back to null instead of a wrong band", () => {
  const q = computeQuotaPressure(
    { a: rec(NOW, { fiveHourPct: -5, sevenDayPct: 140 }) },
    NOW,
  );
  assert.equal(q.fiveHourPct, null);
  assert.equal(q.sevenDayPct, null);
  assert.equal(q.band, "unknown");

  const mixed = computeQuotaPressure(
    { a: rec(NOW, { fiveHourPct: "not a number", sevenDayPct: 30 }) },
    NOW,
  );
  assert.equal(mixed.fiveHourPct, null);
  assert.equal(mixed.sevenDayPct, 30);
  assert.equal(mixed.band, "green");
});

test("reset timestamps convert from epoch seconds to ISO UTC", () => {
  const q = computeQuotaPressure(
    {
      a: rec(NOW, {
        fiveHourPct: 10,
        fiveHourResetsAt: 1_800_003_600, // seconds
        sevenDayPct: 20,
        sevenDayResetsAt: 1_800_600_000,
      }),
    },
    NOW,
  );
  assert.equal(q.fiveHourResetsAt, new Date(1_800_003_600_000).toISOString());
  assert.equal(q.sevenDayResetsAt, new Date(1_800_600_000_000).toISOString());
  assert.match(q.fiveHourResetsAt, /Z$/);
});

test("an unusable reset timestamp is null, not a bogus date", () => {
  const q = computeQuotaPressure(
    {
      a: rec(NOW, {
        fiveHourPct: 10,
        fiveHourResetsAt: 0,
        sevenDayPct: 20,
        sevenDayResetsAt: "tomorrow",
      }),
    },
    NOW,
  );
  assert.equal(q.fiveHourResetsAt, null);
  assert.equal(q.sevenDayResetsAt, null);
  assert.equal(q.fiveHourPct, 10, "a bad reset must not void the reading");
});
