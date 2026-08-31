// @ts-check
import { el, card, pill, emptyState } from "../lib/dom.mjs";

const usd = (n) => "$" + (Number(n) || 0).toFixed(2);
const pct = (n) => Math.round((Number(n) || 0) * 100) + "%";

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

  const tiles = el("div", { class: "kpi-row" }, [
    kpi(
      "Est. live spend",
      usd(rollup.totalCostUsd),
      `${rollup.totalSubagents || 0} subagents · estimate`,
    ),
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
        text: `Estimated API-equivalent cost from ${rollup.costSource || "the local statusline"} — not confirmed billed spend.`,
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
      [warnings, modelCard, agentCard, findings].filter(Boolean),
    ),
  ]);
}
