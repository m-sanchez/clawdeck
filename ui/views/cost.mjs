// @ts-check
import { el, card, pill, emptyState } from "../lib/dom.mjs";
import { sparkline } from "../lib/charts.mjs";

const usd = (n) => "$" + (Number(n) || 0).toFixed(2);
const pct = (n) => Math.round((Number(n) || 0) * 100) + "%";
const compact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(v);
};

// Module-level so the choice survives auto re-renders on each snapshot.
let selectedWindow = "d7";
const WINDOW_LABELS = [
  ["d7", "7d"],
  ["d30", "30d"],
  ["all", "all-time"],
];

/** Historical per-model token/cost breakdown from the OTEL receiver. */
function historyCard(app, otel) {
  if (!otel || !otel.enabled) {
    return card("History by model", [
      emptyState(
        "No OTEL history yet.",
        "Point Claude Code's OTEL metrics exporter (OTLP-JSON) at the panel's /v1/metrics to get 7d / 30d / all-time cost and token breakdowns.",
      ),
    ]);
  }
  const windows = otel.windows || {};
  const win = windows[selectedWindow] || { costUsd: 0, tokens: 0, models: [] };

  const tabs = el(
    "div",
    { class: "cost-window-tabs", role: "tablist" },
    WINDOW_LABELS.map(([key, label]) => {
      const btn = el("button", {
        class: `btn btn-sm ${key === selectedWindow ? "btn-primary" : ""}`,
        role: "tab",
        "aria-selected": String(key === selectedWindow),
        text: label,
      });
      btn.addEventListener("click", () => {
        selectedWindow = key;
        app.rerender?.();
      });
      return btn;
    }),
  );

  const header = el("div", { class: "cp-row cost-window-head" }, [
    tabs,
    el("span", {
      class: "muted small",
      text:
        `${usd(win.costUsd)} · ${compact(win.tokens)} tokens · ${win.days || 0} day(s)` +
        (selectedWindow === "all"
          ? ` · bounded by ${otel.retentionDays || 90}d retention`
          : ""),
    }),
  ]);

  const models = win.models || [];
  const table = models.length
    ? el("div", { class: "cost-model-table" }, [
        el("div", { class: "cost-model-row cost-model-head muted small" }, [
          el("span", { text: "model" }),
          el("span", { text: "cost" }),
          el("span", { text: "input" }),
          el("span", { text: "output" }),
          el("span", { text: "cache read" }),
          el("span", { text: "cache write" }),
        ]),
        ...models.map((m) =>
          el("div", { class: "cost-model-row" }, [
            pill(m.model, /fable/i.test(m.model) ? "warn" : "info"),
            el("strong", { text: usd(m.costUsd) }),
            el("span", { class: "mono small", text: compact(m.input) }),
            el("span", { class: "mono small", text: compact(m.output) }),
            el("span", { class: "mono small", text: compact(m.cacheRead) }),
            el("span", { class: "mono small", text: compact(m.cacheCreation) }),
          ]),
        ),
      ])
    : emptyState(
        "No usage in this window.",
        "Records appear as the OTEL exporter delivers cost/token metrics.",
      );

  return card("History by model", el("div", {}, [header, table]), {
    help: "Historical windows from the optional OTEL receiver (estimated API-equivalent, not billed). Token columns: input / output / cache read / cache write.",
  });
}

function countdownTo(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function burnKpis(burn) {
  const b = burn || {};
  const rate = kpi(
    "Burn rate",
    b.perHourUsd != null ? `${usd(b.perHourUsd)}/h` : "unknown",
    b.stale
      ? "no fresh samples"
      : `last ${b.windowMinutes || 30}m · estimate`,
  );
  const fh = b.fiveHour || {};
  let etaValue = "unknown";
  let etaSub = "no rate-limit data";
  let tone = null;
  if (fh.etaToLimit) {
    etaValue = countdownTo(fh.etaToLimit) || "soon";
    etaSub = `to 5h limit at ${fh.burnPctPerHour}%/h`;
    tone = "warn";
  } else if (fh.usedPct != null) {
    etaValue = `${Math.round(fh.usedPct)}%`;
    etaSub = fh.resetsAt
      ? `5h window · resets in ${countdownTo(fh.resetsAt)}`
      : "5h window used";
  }
  return [rate, kpi("5h limit", etaValue, etaSub, tone)];
}

/** Forecast card: burn sparkline + window slopes + monthly projection. */
function forecastCard(burn) {
  const b = burn || {};
  const rows = [];
  const winRow = (label, w) =>
    el("div", { class: "cp-row" }, [
      pill(label, "neutral"),
      el("span", {
        text: w.usedPct != null ? `${Math.round(w.usedPct)}% used` : "unknown",
      }),
      el("span", {
        class: "muted small",
        text:
          w.burnPctPerHour != null
            ? `${w.burnPctPerHour > 0 ? "+" : ""}${w.burnPctPerHour}%/h`
            : "no slope",
      }),
      el("span", {
        class: "muted small",
        text: w.etaToLimit
          ? `limit in ${countdownTo(w.etaToLimit)}`
          : w.resetsAt
            ? `resets in ${countdownTo(w.resetsAt)}`
            : "",
      }),
    ]);
  rows.push(winRow("5h", b.fiveHour || {}));
  rows.push(winRow("7d", b.sevenDay || {}));
  rows.push(
    el("div", { class: "cp-row" }, [
      pill("month", "neutral"),
      el("span", {
        text:
          b.projectedMonthUsd != null
            ? `~${usd(b.projectedMonthUsd)} projected`
            : "projection needs more history",
      }),
      el("span", {
        class: "muted small",
        text:
          b.projectedMonthUsd != null
            ? `from ${b.coverageHours}h of samples · estimate`
            : `${b.coverageHours || 0}h of 6h sampled`,
      }),
    ]),
  );

  const spark = el("div", { class: "burn-spark" });
  const points = (b.samples || []).map((s) => s.usd);
  if (points.length >= 2) {
    requestAnimationFrame(() => {
      try {
        sparkline(spark, points, { tone: "brand", height: 42, unit: "USD" });
      } catch {
        /* chart helpers degrade on their own */
      }
    });
  } else {
    spark.append(
      el("span", {
        class: "muted small",
        text: "Spend sparkline appears as samples accrue (1/min while sessions run).",
      }),
    );
  }

  const provenance = el("div", {
    class: "muted small",
    text: `$ from ${b.costSource || "statusline deltas"}; window slopes from ${b.quotaSource || "harness rate limits"}.`,
  });

  return card(
    "Burn & forecast",
    el("div", {}, [spark, el("div", { class: "cp-rows" }, rows), provenance]),
    {
      help: "Spend per hour from cumulative statusline cost deltas; 5h/7d depletion from the harness's own rate-limit percentages, sloped within one reset window. Everything is an estimate; unknowns stay unknown.",
    },
  );
}

function kpi(label, value, sub, tone) {
  return el("div", { class: `kpi-card ${tone ? `kpi-${tone}` : ""}` }, [
    el("div", { class: "kpi-label", text: label }),
    el("div", { class: "kpi-value", text: value }),
    sub ? el("div", { class: "kpi-label", text: sub }) : null,
  ]);
}
const rowsOf = (items) => el("div", { class: "cp-rows" }, items);

/**
 * Plan-quota pressure. Informational: it reports the harness's own rate-limit
 * windows and never routes or gates anything.
 */
function quotaKpi(quota) {
  const q = quota || { band: "unknown" };
  const shown = [
    q.fiveHourPct != null ? `5h ${Math.round(q.fiveHourPct)}%` : null,
    q.sevenDayPct != null ? `7d ${Math.round(q.sevenDayPct)}%` : null,
  ].filter(Boolean);
  const sub = !shown.length
    ? "no rate-limit sample yet"
    : q.stale
      ? `${shown.join(" · ")} · stale sample`
      : `${shown.join(" · ")} · heuristic`;
  return kpi(
    "Plan quota pressure",
    q.band === "unknown" ? "unknown" : q.band,
    sub,
    q.band === "red" ? "warn" : null,
  );
}

/** Cost & economics: live spend by model, Fable Governor, avoidable spend. */
export function render(app) {
  const snap = app.snapshot || {};
  const cost = snap.cost || { rollup: {}, findings: [] };
  const rollup = cost.rollup || {};
  const gov = snap.governor || {};
  const fable = rollup.fable || { costUsd: 0, share: 0 };

  const burn = cost.burn || {};
  const tiles = el("div", { class: "kpi-row" }, [
    kpi(
      "Est. live spend",
      usd(rollup.totalCostUsd),
      `${rollup.totalSubagents || 0} subagents · estimate`,
    ),
    ...burnKpis(burn),
    kpi(
      "Est. Fable",
      usd(fable.costUsd),
      `${pct(fable.share)} of live spend`,
      fable.share > 0.6 ? "warn" : null,
    ),
    kpi(
      "Governor",
      gov.mode || "warn",
      `soft loop budget ${usd(gov.perLoopSoftUsd)}`,
    ),
    quotaKpi(snap.quotaPressure),
  ]);

  // One honest provenance line so no number reads as confirmed billed spend.
  const provenance = el(
    "div",
    { class: "muted small", style: "margin:4px 0 2px" },
    [
      el("span", {
        text: `Estimated API-equivalent cost from ${rollup.costSource || "the local statusline"} - not confirmed billed spend.`,
      }),
    ],
  );

  const warnings = (gov.warnings || []).length
    ? card(
        "Governor warnings",
        rowsOf(
          (gov.warnings || []).map((w) =>
            el("div", { class: "cp-row" }, [
              pill(w.type, "warn"),
              el("span", { text: w.detail }),
            ]),
          ),
        ),
      )
    : null;

  const byModel = Object.entries(rollup.byModel || {});
  const modelCard = card(
    "By model (estimated)",
    byModel.length
      ? rowsOf(
          byModel
            .sort((a, b) => (b[1].costUsd || 0) - (a[1].costUsd || 0))
            .map(([model, v]) =>
              el("div", { class: "cp-row" }, [
                pill(model, /fable/i.test(model) ? "warn" : "info"),
                el("strong", { text: usd(v.costUsd) }),
                el("span", {
                  class: "muted small",
                  text: `${v.sessions} session(s)`,
                }),
              ]),
            ),
        )
      : emptyState(
          "No cost samples yet.",
          "Start a Claude session; the statusline bridge records cost.",
        ),
  );

  const byType = Object.entries(rollup.byAgentType || {});
  const agentCard = byType.length
    ? card(
        "Subagents by type",
        rowsOf(
          byType
            .sort((a, b) => b[1] - a[1])
            .map(([type, n]) =>
              el("div", { class: "cp-row" }, [
                pill(type, "neutral"),
                el("span", { text: `${n} launch(es)` }),
              ]),
            ),
        ),
      )
    : null;

  const findings = (cost.findings || []).length
    ? card(
        "Avoidable spend",
        rowsOf(
          (cost.findings || []).map((f) =>
            el("div", {}, [
              el("div", { class: "cp-row" }, [
                pill(f.type, f.severity === "warn" ? "warn" : "neutral"),
                el("span", { text: f.detail }),
              ]),
              el("div", {
                class: "muted small",
                text: `measured by: ${f.measurement}`,
              }),
            ]),
          ),
        ),
      )
    : card("Avoidable spend", [
        emptyState(
          "No avoidable spend detected.",
          "Readers on Fable and high fan-out show up here.",
        ),
      ]);

  return el("div", { class: "view cp-view" }, [
    tiles,
    provenance,
    el(
      "div",
      { class: "cp-card-grid" },
      [
        forecastCard(burn),
        warnings,
        historyCard(app, cost.otel),
        modelCard,
        agentCard,
        findings,
      ].filter(Boolean),
    ),
  ]);
}
