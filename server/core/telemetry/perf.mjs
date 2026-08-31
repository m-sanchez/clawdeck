// @ts-check
/**
 * Panel self-performance metrics: a small in-process ring of recent samples for
 * snapshot-build and per-adapter durations, plus monotonic counters (ingest
 * failures, dropped events). Bounded, dependency-free. Percentiles are computed
 * over the retained window so the Health view shows real p50/p95 latency rather
 * than process trivia.
 */

const WINDOW = 200;

export class PerfMetrics {
  constructor(window = WINDOW) {
    this.window = window;
    /** @type {number[]} recent snapshot build durations (ms) */
    this.snapshotMs = [];
    /** @type {Record<string, number[]>} recent per-adapter durations (ms) */
    this.adapterMs = {};
    this.ingestOk = 0;
    this.ingestFailed = 0;
    this.eventsDropped = 0;
  }

  _push(arr, v) {
    arr.push(v);
    if (arr.length > this.window) arr.shift();
  }

  recordSnapshot(ms) {
    if (Number.isFinite(ms)) this._push(this.snapshotMs, ms);
  }
  recordAdapter(name, ms) {
    if (!name || !Number.isFinite(ms)) return;
    if (!this.adapterMs[name]) this.adapterMs[name] = [];
    this._push(this.adapterMs[name], ms);
  }
  recordIngest(ok) {
    if (ok) this.ingestOk++;
    else this.ingestFailed++;
  }
  recordDropped(n = 1) {
    this.eventsDropped += n;
  }

  static percentile(arr, p) {
    if (!arr || !arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return Math.round(sorted[idx] * 100) / 100;
  }

  /** @param {{ sseClients?:number, eventBacklog?:number, spoolLagMs?:number, eventStoreBytes?:number }} [live] */
  summary(live = {}) {
    const pct = PerfMetrics.percentile;
    const adapters = {};
    let slowest = null;
    for (const [name, arr] of Object.entries(this.adapterMs)) {
      const p95 = pct(arr, 95);
      adapters[name] = { p50: pct(arr, 50), p95, samples: arr.length };
      if (p95 != null && (!slowest || p95 > slowest.p95))
        slowest = { name, p95 };
    }
    return {
      snapshot: {
        p50: pct(this.snapshotMs, 50),
        p95: pct(this.snapshotMs, 95),
        samples: this.snapshotMs.length,
      },
      adapters,
      slowestAdapter: slowest,
      ingest: { ok: this.ingestOk, failed: this.ingestFailed },
      eventsDropped: this.eventsDropped,
      sseClients: live.sseClients ?? null,
      eventBacklog: live.eventBacklog ?? null,
      spoolLagMs: live.spoolLagMs ?? null,
      eventStoreBytes: live.eventStoreBytes ?? null,
    };
  }
}
