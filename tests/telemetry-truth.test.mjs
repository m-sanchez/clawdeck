// @ts-check
/**
 * T1/T2 regression tests: live telemetry contains only FRESH sessions (stale
 * ones drop out of the live spend number but remain available historically),
 * and every cost figure is labelled as an ESTIMATE derived from the statusline
 * cost (never presented as confirmed billed spend).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLiveTelemetry } from "../server/adapters/telemetry-live.mjs";
import { rollupCost } from "../server/core/telemetry/rollup.mjs";

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tt-"));
}
function writeSession(rootDir, id, rec) {
  const dir = path.join(
    rootDir,
    ".claude",
    ".runtime",
    "telemetry",
    "sessions",
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec));
}

const DAY = 86400000;

// ── T2: live window excludes stale sessions from the live number ──

test("T2: a days-old session is excluded from live spend but kept historically", () => {
  const a = root();
  const now = 10 * DAY;
  writeSession(a, "fresh", {
    sessionId: "fresh",
    costUsd: 1.0,
    ts: now - 60000,
  });
  writeSession(a, "stale", {
    sessionId: "stale",
    costUsd: 5.0,
    ts: now - 3 * DAY,
  });
  const out = getLiveTelemetry({ checkoutRoot: a }, [], now);

  // live view: only the fresh session contributes to the live number
  assert.equal(out.liveCount, 1, "one live session");
  assert.equal(out.sumLiveCostUsd, 1.0, "stale cost excluded from live spend");
  assert.ok(out.live.fresh, "fresh session in live view");
  assert.ok(!out.live.stale, "stale session absent from live view");

  // historical view: both remain available
  assert.equal(out.historicalCount, 2);
  assert.ok(out.sessions.stale, "stale session still available historically");
  assert.equal(out.sessions.stale.stale, true, "stale flag set");
  assert.equal(out.sessions.fresh.stale, false);
});

test("T2: an ended session (SessionEnd sample) is not live", () => {
  const a = root();
  const now = 5 * DAY;
  writeSession(a, "ended", {
    sessionId: "ended",
    costUsd: 2.0,
    ts: now - 30000,
    ended: true,
  });
  const out = getLiveTelemetry({ checkoutRoot: a }, [], now);
  assert.equal(out.liveCount, 0, "ended session not counted live");
  assert.equal(out.sumLiveCostUsd, 0);
  assert.ok(out.sessions.ended, "still available historically");
});

test("T2: explicit liveWindowMs is honoured", () => {
  const a = root();
  const now = 1_000_000;
  writeSession(a, "s", { sessionId: "s", costUsd: 1, ts: now - 20000 });
  const tight = getLiveTelemetry({ checkoutRoot: a }, [], now, {
    liveWindowMs: 10000,
  });
  assert.equal(tight.liveCount, 0, "20s-old sample outside a 10s window");
  const loose = getLiveTelemetry({ checkoutRoot: a }, [], now, {
    liveWindowMs: 60000,
  });
  assert.equal(loose.liveCount, 1);
});

test("newest sample per session still wins (regression)", () => {
  const a = root();
  const b = root();
  const now = 3000;
  writeSession(a, "s1", { sessionId: "s1", costUsd: 0.1, ts: 1000 });
  writeSession(b, "s1", { sessionId: "s1", costUsd: 0.9, ts: 2000 });
  const out = getLiveTelemetry({ checkoutRoot: a }, [{ path: b }], now);
  assert.equal(out.sessions.s1.costUsd, 0.9);
  assert.equal(out.liveCount, 1);
});

// ── T1: cost is labelled as an estimate with a named source ──

test("T1: rollup marks cost estimated and names the source; live-only total", () => {
  const now = 10 * DAY;
  const telemetry = getLiveTelemetryFixture(now);
  const roll = rollupCost(telemetry, { sessions: [] });
  assert.equal(roll.estimated, true, "cost must be flagged as an estimate");
  assert.match(
    String(roll.costSource || ""),
    /statusline|estimate/i,
    "source names the statusline estimate",
  );
  // only the live session's cost is in the live rollup total
  assert.equal(
    roll.totalCostUsd,
    1.0,
    "stale session excluded from rollup total",
  );
});

/** Build a telemetry object with one fresh + one stale session. */
function getLiveTelemetryFixture(now) {
  const a = root();
  writeSession(a, "fresh", {
    sessionId: "fresh",
    model: "fable",
    costUsd: 1.0,
    ts: now - 60000,
  });
  writeSession(a, "stale", {
    sessionId: "stale",
    model: "fable",
    costUsd: 5.0,
    ts: now - 3 * DAY,
  });
  return getLiveTelemetry({ checkoutRoot: a }, [], now);
}
