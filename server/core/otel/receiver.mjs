// @ts-check
/**
 * Optional historical telemetry: parse Claude Code's OTLP-JSON metrics (cost /
 * token usage) with NO dependency (OTLP-JSON is just JSON). Point Claude's OTEL
 * exporter at the panel's loopback /v1/metrics for per-request cost attribution
 * that complements the live statusline layer.
 *
 * The store keeps privacy-safe NORMALIZED records (model + attribution dims +
 * value, never prompt/response/source) as rotating NDJSON day files under a
 * given dir, so history survives a panel restart. With no dir it is in-memory
 * only (back-compat). De-dup coverage: a re-delivered CUMULATIVE snapshot
 * resolves to a zero delta (idempotent); a DELTA re-delivery is caught by an
 * in-session (series|ts|value) guard; and any record bearing a stable id
 * (attrs.id / metric.id) is id-deduped. Residuals (rare, bounded — cost is
 * best-effort, not billing-accurate): a delta retried after a restart, a daily
 * rotate(), or eviction from the bounded guard is counted again (over-count);
 * two distinct deltas colliding on the same ms-rounded ts AND value are merged
 * (under-count).
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

function attrVal(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("doubleValue" in v) return v.doubleValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("boolValue" in v) return v.boolValue;
  return null;
}
function attrsToObj(attrs) {
  const o = {};
  for (const a of attrs || []) o[a.key] = attrVal(a.value);
  return o;
}

const WANTED = new Set(["claude_code.cost.usage", "claude_code.token.usage"]);

/**
 * Extract the cost/token data points from an OTLP-JSON metrics payload.
 * @param {any} body
 * @returns {{metric:string, value:number, attrs:Record<string,any>, ts:number, cumulative:boolean}[]}
 */
export function parseOtlpMetrics(body) {
  const out = [];
  for (const rm of body?.resourceMetrics || []) {
    for (const sm of rm.scopeMetrics || []) {
      for (const m of sm.metrics || []) {
        if (!WANTED.has(m.name)) continue;
        const points = m.sum?.dataPoints || m.gauge?.dataPoints || [];
        // OTLP sum temporality: 2 = cumulative (running total), 1 = delta.
        const cumulative = m.sum?.aggregationTemporality === 2;
        for (const p of points) {
          const value =
            typeof p.asDouble === "number" ? p.asDouble : Number(p.asInt || 0);
          out.push({
            metric: m.name,
            value,
            attrs: attrsToObj(p.attributes),
            // timeUnixNano is NANOSECONDS; convert to ms for any Date use
            // (new Date(ns) overflows and throws, silently killing persistence).
            ts: Math.round(Number(p.timeUnixNano || 0) / 1e6),
            cumulative,
          });
        }
      }
    }
  }
  return out;
}

const round = (n) => Math.round(n * 1e6) / 1e6;
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

/** Canonical token-usage type. Claude Code emits input/output/cacheRead/cacheCreation. */
export function normalizeTokenType(t) {
  const v = String(t || "").toLowerCase().replace(/[^a-z]/g, "");
  if (v === "input") return "input";
  if (v === "output") return "output";
  if (v === "cacheread") return "cacheRead";
  if (v === "cachecreation" || v === "cachecreate" || v === "cachewrite")
    return "cacheCreation";
  return "other";
}

/** First present attribution value across a few known attribute spellings. */
function pick(attrs, keys) {
  for (const k of keys) {
    if (attrs[k] != null && attrs[k] !== "") return String(attrs[k]);
  }
  return null;
}

/**
 * Accumulates parsed OTEL cost/token usage by model + attribution dims. Panel-
 * owned, single-writer. Persistent when constructed with a `dir`.
 */
export class OtelStore {
  /**
   * @param {{ dir?: string, retentionDays?: number, now?: () => number }} [opts]
   */
  constructor(opts = {}) {
    this.dir = opts.dir || null;
    this.retentionDays = opts.retentionDays ?? 90;
    this.now = opts.now || (() => Date.now());
    /**
     * Per-day, per-model aggregates for the 7d/30d/all-time windows. "all" is
     * bounded by retentionDays — the honest maximum this store can answer for.
     * @type {Map<string, Map<string, {costUsd:number, tokens:number, types:Record<string,number>}>>}
     */
    this.byDay = new Map();
    /** @type {Record<string, {costUsd:number, tokens:number}>} */
    this.byModel = {};
    /** @type {Record<string, {costUsd:number, tokens:number}>} */
    this.byAgentType = {};
    /** @type {Record<string, {costUsd:number, tokens:number}>} */
    this.byQuerySource = {};
    this.totalCostUsd = 0;
    this.totalTokens = 0;
    this.records = 0;
    /** @type {Set<string>} stable-id dedup */
    this.seen = new Set();
    /** @type {Map<string, number>} last cumulative value per series (delta-ize) */
    this.cumulativeLast = new Map();
    /** @type {Set<string>} bounded (series|ts|value) keys for delta retry dedup */
    this.deltaSeen = new Set();
    if (this.dir) {
      try {
        mkdirSync(this.dir, { recursive: true });
      } catch {
        /* fall back to in-memory */
      }
      this._loadHistory();
    }
  }

  /** Bounded dedup of an exact delta re-delivery (series+ts+value). */
  _isDeltaRetry(seriesKey, ts, value) {
    const k = `${seriesKey}|${ts}|${value}`;
    if (this.deltaSeen.has(k)) return true;
    this.deltaSeen.add(k);
    if (this.deltaSeen.size > 5000)
      this.deltaSeen.delete(this.deltaSeen.values().next().value);
    return false;
  }

  _bucket(map, key, costUsd, tokens) {
    if (!key) return;
    if (!map[key]) map[key] = { costUsd: 0, tokens: 0 };
    map[key].costUsd += costUsd;
    map[key].tokens += tokens;
  }

  /** Accumulate one normalized record into the in-memory aggregates. */
  _accumulate(rec) {
    if (rec.id && this.seen.has(rec.id)) return false;
    if (rec.id) this.seen.add(rec.id);
    // Rebuild the per-series cumulative baseline from persisted history so a
    // continuing cumulative series after restart deltas from the right prev.
    if (
      rec.cumulative &&
      rec.seriesKey != null &&
      typeof rec.cumRaw === "number"
    ) {
      const prev = this.cumulativeLast.get(rec.seriesKey) || 0;
      if (rec.cumRaw > prev) this.cumulativeLast.set(rec.seriesKey, rec.cumRaw);
    }
    this.records++;
    const cost = rec.metric === "cost" ? rec.value : 0;
    const tokens = rec.metric === "tokens" ? rec.value : 0;
    this.totalCostUsd += cost;
    this.totalTokens += tokens;
    this._bucket(this.byModel, rec.model || "unknown", cost, tokens);
    this._bucket(this.byAgentType, rec.agentType, cost, tokens);
    this._bucket(this.byQuerySource, rec.querySource, cost, tokens);
    this._bucketDay(rec, cost, tokens);
    return true;
  }

  /** Fold one record into the per-day, per-model window aggregates. */
  _bucketDay(rec, cost, tokens) {
    const day = dayOf(rec.ts || this.now());
    let models = this.byDay.get(day);
    if (!models) this.byDay.set(day, (models = new Map()));
    const model = rec.model || "unknown";
    let agg = models.get(model);
    if (!agg) models.set(model, (agg = { costUsd: 0, tokens: 0, types: {} }));
    agg.costUsd += cost;
    agg.tokens += tokens;
    if (tokens) {
      const type = normalizeTokenType(rec.tokenType);
      agg.types[type] = (agg.types[type] || 0) + tokens;
    }
  }

  /**
   * Time-windowed totals + per-model input/output/cache breakdowns.
   * "all" spans everything loaded, i.e. at most retentionDays of history.
   * @returns {{ d7: object, d30: object, all: object }}
   */
  windows() {
    const build = (cutoffDay) => {
      /** @type {Record<string, {costUsd:number, tokens:number, types:Record<string,number>}>} */
      const perModel = {};
      let costUsd = 0;
      let tokens = 0;
      let days = 0;
      for (const [day, models] of this.byDay) {
        if (cutoffDay && day < cutoffDay) continue;
        days++;
        for (const [model, v] of models) {
          const agg =
            perModel[model] ||
            (perModel[model] = { costUsd: 0, tokens: 0, types: {} });
          agg.costUsd += v.costUsd;
          agg.tokens += v.tokens;
          costUsd += v.costUsd;
          tokens += v.tokens;
          for (const [t, n] of Object.entries(v.types))
            agg.types[t] = (agg.types[t] || 0) + n;
        }
      }
      const models = Object.entries(perModel)
        .map(([model, v]) => ({
          model,
          costUsd: round(v.costUsd),
          tokens: v.tokens,
          input: v.types.input || 0,
          output: v.types.output || 0,
          cacheRead: v.types.cacheRead || 0,
          cacheCreation: v.types.cacheCreation || 0,
          other: v.types.other || 0,
        }))
        .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
      return { costUsd: round(costUsd), tokens, days, models };
    };
    const now = this.now();
    return {
      d7: build(dayOf(now - 7 * 86400000)),
      d30: build(dayOf(now - 30 * 86400000)),
      all: build(null),
    };
  }

  /** @param {any} body OTLP-JSON metrics payload */
  ingestMetrics(body) {
    const recs = parseOtlpMetrics(body);
    let n = 0;
    for (const r of recs) {
      const metric = r.metric === "claude_code.token.usage" ? "tokens" : "cost";
      const model =
        pick(r.attrs, ["model", "model_id", "model.id"]) || "unknown";
      // Claude Code's real cost/token metric dimensions are model, query_source,
      // agent.name, session.id (see the monitoring docs) — not agent_type /
      // workflow. Read the real keys, keep the old ones as tolerant fallbacks.
      const agentType = pick(r.attrs, [
        "agent.name",
        "agent_name",
        "agent_type",
        "agentType",
      ]);
      const querySource = pick(r.attrs, [
        "query_source",
        "query.source",
        "source",
      ]);
      const sessionId = pick(r.attrs, [
        "session.id",
        "session_id",
        "sessionId",
      ]);
      // token.usage carries a `type` (input/output/cacheRead/cacheCreation)
      // dimension; it must distinguish series or concurrent token totals collide.
      const tokenType = pick(r.attrs, ["type", "token.type", "token_type"]);
      // Claude Code emits no per-datapoint id; derive a stable series key from
      // EVERY distinguishing dimension so independent concurrent series (e.g.
      // two query_source totals, or the four token types) never share a
      // cumulative baseline.
      const id = pick(r.attrs, ["metric.id", "id", "request.id"]) || null;
      const seriesKey = `${metric}|${model}|${agentType || ""}|${querySource || ""}|${sessionId || ""}|${tokenType || ""}`;

      let value = r.value;
      let cumRaw = null;
      if (r.cumulative) {
        // Cumulative = running total; store the delta only. Persist the RAW
        // running total + series key so _loadHistory can rebuild the per-series
        // baseline after a restart (otherwise the next live snapshot would
        // delta from 0 and re-add the whole pre-restart total).
        cumRaw = value;
        const prev = this.cumulativeLast.get(seriesKey) || 0;
        const delta = value - prev;
        // Baseline is MONOTONIC: an out-of-order/lower snapshot must not lower it
        // (that would double-count the next higher snapshot). Matches the reload
        // path. A genuine counter RESET therefore under-counts until it passes
        // the prior peak — conservative (never over-states cost).
        this.cumulativeLast.set(seriesKey, Math.max(prev, value));
        value = delta > 0 ? delta : 0;
      } else if (this._isDeltaRetry(seriesKey, r.ts, value)) {
        // Delta temporality with no stable id: an exact (series, ts, value)
        // repeat is TREATED as an OTLP/HTTP exporter retry and skipped. Known
        // imperfections (rare, bounded — cost here is best-effort, not billing):
        //  - under-count: two genuinely distinct deltas that collide on the same
        //    ms-rounded ts AND value are also dropped.
        //  - over-count: a retry whose key was evicted from the bounded set, or
        //    that arrives after a restart or a daily rotate() cleared the set, is
        //    not recognized and is counted again.
        continue;
      }

      const norm = {
        ts: r.ts || this.now(),
        metric,
        value,
        model,
        agentType,
        querySource,
        sessionId,
        tokenType,
        id,
        ...(r.cumulative ? { cumulative: true, seriesKey, cumRaw } : {}),
      };
      if (this._accumulate(norm)) {
        n++;
        this._persist(norm);
      }
    }
    return n;
  }

  _persist(rec) {
    if (!this.dir) return;
    try {
      appendFileSync(
        join(this.dir, `otel-${dayOf(rec.ts)}.ndjson`),
        JSON.stringify(rec) + "\n",
      );
    } catch {
      /* persistence best-effort; aggregates remain correct in memory */
    }
  }

  _loadHistory() {
    let files;
    try {
      files = readdirSync(this.dir).filter((f) =>
        /^otel-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f),
      );
    } catch {
      return;
    }
    const cutoff = dayOf(this.now() - this.retentionDays * 86400000);
    for (const f of files.sort()) {
      const day = f.slice(5, 15);
      if (day < cutoff) continue; // retention: skip stale files on load
      let buf;
      try {
        buf = readFileSync(join(this.dir, f), "utf8");
      } catch {
        continue;
      }
      for (const line of buf.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          this._accumulate(JSON.parse(t));
        } catch {
          /* skip a torn line */
        }
      }
    }
  }

  /** Reset the in-memory aggregates (before a rebuild from surviving files). */
  _resetAggregates() {
    this.byDay = new Map();
    this.byModel = {};
    this.byAgentType = {};
    this.byQuerySource = {};
    this.totalCostUsd = 0;
    this.totalTokens = 0;
    this.records = 0;
    this.seen = new Set();
    this.cumulativeLast = new Map();
    this.deltaSeen = new Set();
  }

  /**
   * Delete day files older than the retention window AND rebuild the in-memory
   * aggregates from the survivors, so totalCostUsd / byModel / seen /
   * cumulativeLast track the window rather than whole-process-lifetime spend
   * (mirrors EventStore.rotate). In-memory only (no dir) is a no-op.
   */
  rotate() {
    if (!this.dir) return;
    const cutoff = dayOf(this.now() - this.retentionDays * 86400000);
    let files;
    try {
      files = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const f of files) {
      const m = /^otel-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(f);
      if (m && m[1] < cutoff) {
        try {
          rmSync(join(this.dir, f), { force: true });
        } catch {
          /* ignore */
        }
      }
    }
    this._resetAggregates();
    this._loadHistory();
  }

  summary() {
    const project = (map) => {
      const out = {};
      for (const [k, v] of Object.entries(map))
        out[k] = { costUsd: round(v.costUsd), tokens: v.tokens };
      return out;
    };
    return {
      enabled: this.records > 0,
      persistent: Boolean(this.dir),
      totalCostUsd: round(this.totalCostUsd),
      totalTokens: this.totalTokens,
      byModel: project(this.byModel),
      byAgentType: project(this.byAgentType),
      byQuerySource: project(this.byQuerySource),
      records: this.records,
      retentionDays: this.retentionDays,
      windows: this.windows(),
      // Provenance parity with the live rollup: OTEL cost is an estimate, not
      // billed spend.
      estimated: true,
      costSource:
        "OTEL claude_code.cost.usage (estimated API-equivalent, not billed)",
    };
  }
}
