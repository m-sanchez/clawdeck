// @ts-check
/** Host metrics: CPU delta math, null-not-zero semantics, disk seam. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpuTotals,
  computeCpuPct,
  sampleHostMetrics,
} from "../server/adapters/host-metrics.mjs";

const cpus = (idle, busy) => [
  { times: { idle, user: busy, sys: 0, nice: 0, irq: 0 } },
];

test("cpuTotals aggregates across cores", () => {
  const t = cpuTotals([
    { times: { idle: 10, user: 20 } },
    { times: { idle: 5, user: 15 } },
  ]);
  assert.deepEqual(t, { idle: 15, total: 50 });
});

test("computeCpuPct: 50% busy delta", () => {
  const prev = { idle: 100, total: 200 };
  const next = { idle: 150, total: 300 };
  assert.equal(computeCpuPct(prev, next), 50);
});

test("computeCpuPct: no prior sample or zero delta means null", () => {
  assert.equal(computeCpuPct(null, { idle: 1, total: 2 }), null);
  assert.equal(
    computeCpuPct({ idle: 1, total: 2 }, { idle: 1, total: 2 }),
    null,
  );
});

test("first sample reports null cpu, second reports the delta", () => {
  const fakeOs = {
    calls: 0,
    cpus() {
      this.calls++;
      return this.calls <= 2 ? cpus(100, 100) : cpus(150, 250);
    },
    totalmem: () => 8 * 1073741824,
    freemem: () => 2 * 1073741824,
  };
  const first = sampleHostMetrics(".", {
    os: fakeOs,
    reset: true,
    statfs: () => {
      throw new Error("n/a");
    },
  });
  assert.equal(first.cpuPct, null);
  assert.equal(first.memUsedPct, 75);
  assert.equal(first.disk, null);
  const second = sampleHostMetrics(".", {
    os: fakeOs,
    statfs: () => {
      throw new Error("n/a");
    },
  });
  // idle +50, total +200 -> busy 150/200 = 75%
  assert.equal(second.cpuPct, 75);
});

test("disk math from statfs blocks", () => {
  const fakeOs = {
    cpus: () => cpus(1, 1),
    totalmem: () => 1073741824,
    freemem: () => 1073741824 / 2,
  };
  const s = sampleHostMetrics("/", {
    os: fakeOs,
    reset: true,
    statfs: () => ({ blocks: 1000, bavail: 250, bsize: 1073741824 }),
  });
  assert.equal(s.disk.totalGB, 1000);
  assert.equal(s.disk.freeGB, 250);
  assert.equal(s.disk.usedPct, 75);
});

test("real environment sample has the expected shape", () => {
  const s = sampleHostMetrics(process.cwd(), { reset: true });
  assert.ok(s.cores >= 1);
  assert.ok(s.memTotalMB > 0);
  assert.ok(s.memUsedPct > 0 && s.memUsedPct < 100);
  assert.ok(s.sampledAt > 0);
});
