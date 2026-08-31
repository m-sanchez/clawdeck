// @ts-check
/**
 * Burn sampling + forecasting: cumulative-delta math, ts-keyed dedup, reset
 * segmentation, projection coverage gate, provenance. Run: node --test
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordBurnSample,
  readBurnHistory,
  computeBurn,
  burnHistoryPath,
  BURN_SAMPLE_CAP,
} from "../server/core/telemetry/burn.mjs";

let dir;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "clawdeck-burn-"))));
after(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse("2026-08-31T12:00:00Z");
const MIN = 60000;
const rec = (sid, ts, costUsd, rl) => ({
  sessionId: sid,
  ts,
  costUsd,
  rateLimits: rl,
});

test("first sighting baselines without attributing; growth becomes deltas", () => {
  recordBurnSample(dir, [rec("s1", T0, 5.0)], T0);
  let h = readBurnHistory(dir);
  assert.equal(h.samples.length, 1);
  assert.equal(h.samples[0].usd, 0, "cumulative total not attributed");

  recordBurnSample(dir, [rec("s1", T0 + MIN, 5.4)], T0 + MIN);
  h = readBurnHistory(dir);
  assert.equal(h.samples.length, 2);
  assert.equal(h.samples[1].usd, 0.4);
});

test("unchanged record ts appends nothing", () => {
  recordBurnSample(dir, [rec("s1", T0, 1.0)], T0);
  const r = recordBurnSample(dir, [rec("s1", T0, 1.0)], T0 + MIN);
  assert.equal(r.appended, false);
  assert.equal(readBurnHistory(dir).samples.length, 1);
});

test("cumulative reset clamps to zero and re-baselines", () => {
  recordBurnSample(dir, [rec("s1", T0, 5.0)], T0);
  recordBurnSample(dir, [rec("s1", T0 + MIN, 0.2)], T0 + MIN); // restart
  let h = readBurnHistory(dir);
  assert.equal(h.samples[1].usd, 0, "negative delta clamped");
  recordBurnSample(dir, [rec("s1", T0 + 2 * MIN, 0.5)], T0 + 2 * MIN);
  h = readBurnHistory(dir);
  assert.equal(h.samples[2].usd, 0.3, "post-reset growth from new baseline");
});

test("sample cap holds and the file stays valid JSON", () => {
  for (let i = 0; i < BURN_SAMPLE_CAP + 25; i++)
    recordBurnSample(dir, [rec("s1", T0 + i * MIN, i * 0.01)], T0 + i * MIN);
  const parsed = JSON.parse(readFileSync(burnHistoryPath(dir), "utf8"));
  assert.equal(parsed.samples.length, BURN_SAMPLE_CAP);
});

test("multiple sessions aggregate into one sample", () => {
  recordBurnSample(dir, [rec("a", T0, 1.0), rec("b", T0, 2.0)], T0);
  recordBurnSample(
    dir,
    [rec("a", T0 + MIN, 1.5), rec("b", T0 + MIN, 2.25)],
    T0 + MIN,
  );
  const h = readBurnHistory(dir);
  assert.equal(h.samples[1].usd, 0.75);
});

test("computeBurn: empty window means null perHourUsd, never zero", () => {
  const b = computeBurn({ samples: [] }, null, T0);
  assert.equal(b.perHourUsd, null);
  assert.equal(b.stale, true);
  assert.equal(b.sampledAt, null);
  assert.equal(b.estimated, true);
  assert.ok(b.costSource.includes("statusline"));
  assert.ok(b.quotaSource.includes("rate_limits"));
});

test("perHourUsd scales the trailing 30-minute window", () => {
  const samples = [];
  for (let i = 0; i < 30; i++)
    samples.push({ t: T0 - (29 - i) * MIN, usd: 0.02, srcTs: T0 });
  const b = computeBurn({ samples }, null, T0);
  assert.equal(b.perHourUsd, 1.2); // 0.6 USD in 30min -> 1.2/h
});

test("quota slope + ETA within one epoch", () => {
  const reset = Math.floor((T0 + 3 * 3600000) / 1000);
  const samples = [
    {
      t: T0 - 60 * MIN,
      usd: 0,
      srcTs: T0,
      fiveHourPct: 40,
      fiveHourResetsAt: reset,
    },
    { t: T0, usd: 0, srcTs: T0, fiveHourPct: 50, fiveHourResetsAt: reset },
  ];
  const b = computeBurn({ samples }, null, T0);
  assert.equal(b.fiveHour.burnPctPerHour, 10);
  // 50 pct left at 10 pct/h = 5h away, but the reset (3h) precedes it -> null.
  assert.equal(b.fiveHour.etaToLimit, null);
});

test("ETA reported when the limit precedes the reset", () => {
  const reset = Math.floor((T0 + 4 * 3600000) / 1000);
  const samples = [
    {
      t: T0 - 60 * MIN,
      usd: 0,
      srcTs: T0,
      fiveHourPct: 60,
      fiveHourResetsAt: reset,
    },
    { t: T0, usd: 0, srcTs: T0, fiveHourPct: 80, fiveHourResetsAt: reset },
  ];
  const b = computeBurn({ samples }, null, T0);
  assert.equal(b.fiveHour.burnPctPerHour, 20);
  assert.equal(b.fiveHour.etaToLimit, new Date(T0 + 3600000).toISOString());
});

test("reset epoch segmentation: 92 -> 4 never yields negative slope", () => {
  const r1 = Math.floor(T0 / 1000);
  const r2 = Math.floor((T0 + 5 * 3600000) / 1000);
  const samples = [
    {
      t: T0 - 20 * MIN,
      usd: 0,
      srcTs: T0,
      fiveHourPct: 88,
      fiveHourResetsAt: r1,
    },
    {
      t: T0 - 10 * MIN,
      usd: 0,
      srcTs: T0,
      fiveHourPct: 92,
      fiveHourResetsAt: r1,
    },
    { t: T0, usd: 0, srcTs: T0, fiveHourPct: 4, fiveHourResetsAt: r2 },
    {
      t: T0 + 10 * MIN,
      usd: 0,
      srcTs: T0,
      fiveHourPct: 9,
      fiveHourResetsAt: r2,
    },
  ];
  const b = computeBurn({ samples }, null, T0 + 10 * MIN);
  assert.equal(b.fiveHour.burnPctPerHour, 30, "slope from the new epoch only");
  assert.ok(b.fiveHour.burnPctPerHour > 0);
});

test("pct drop without resetsAt still segments", () => {
  const samples = [
    {
      t: T0 - 10 * MIN,
      usd: 0,
      srcTs: T0,
      fiveHourPct: 90,
      fiveHourResetsAt: null,
    },
    { t: T0, usd: 0, srcTs: T0, fiveHourPct: 5, fiveHourResetsAt: null },
    {
      t: T0 + 10 * MIN,
      usd: 0,
      srcTs: T0,
      fiveHourPct: 8,
      fiveHourResetsAt: null,
    },
  ];
  const b = computeBurn({ samples }, null, T0 + 10 * MIN);
  assert.equal(b.fiveHour.burnPctPerHour, 18);
});

test("projection needs coverage; then scales to the month", () => {
  const short = [
    { t: T0 - 2 * 3600000, usd: 1, srcTs: T0 },
    { t: T0, usd: 1, srcTs: T0 },
  ];
  assert.equal(
    computeBurn({ samples: short }, null, T0).projectedMonthUsd,
    null,
  );

  const long = [];
  for (let h = 0; h <= 12; h++)
    long.push({ t: T0 - (12 - h) * 3600000, usd: 0.5, srcTs: T0 });
  const b = computeBurn({ samples: long }, null, T0);
  assert.equal(b.coverageHours, 12);
  // 6.5 USD over 12h -> 0.5417/h * 24 * 31 (Aug) = 403.0
  assert.ok(
    Math.abs(b.projectedMonthUsd - 403) < 1.5,
    String(b.projectedMonthUsd),
  );
});

test("fresh quotaPressure wins over sample readings for usedPct", () => {
  const samples = [
    { t: T0 - MIN, usd: 0, srcTs: T0, fiveHourPct: 40, fiveHourResetsAt: null },
  ];
  const qp = { stale: false, fiveHourPct: 55, fiveHourResetsAt: null };
  const b = computeBurn({ samples }, qp, T0);
  assert.equal(b.fiveHour.usedPct, 55);
  const bStale = computeBurn({ samples }, { ...qp, stale: true }, T0);
  assert.equal(bStale.fiveHour.usedPct, 40);
});
