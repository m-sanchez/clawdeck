// @ts-check
import { el, card, pill } from "../lib/dom.mjs";

const MARK = {
  done: "✓",
  current: "•",
  blocked: "✕",
  pending: "○",
  skipped: "–",
};
const TONE = {
  done: "ok",
  current: "info",
  blocked: "danger",
  pending: "neutral",
  skipped: "neutral",
};

function stageBox(s) {
  return el("div", { class: `cp-stage state-${s.state}` }, [
    el("div", { class: "cp-row" }, [
      el("span", { text: MARK[s.state] || "○" }),
      el("strong", { class: "small", text: s.label }),
    ]),
    el("div", { class: "muted small", text: s.detail || "" }),
    pill(s.state, TONE[s.state] || "neutral"),
  ]);
}

/** Delivery Conveyor: one lifecycle from local change to merged, with blockers. */
export function render(app) {
  const d = app.snapshot?.delivery || {
    stages: [],
    blockers: [],
    nextAction: "",
    hasChanges: false,
  };
  const banner = el("div", { class: "cp-banner" }, [
    pill("next", d.hasChanges ? "info" : "ok"),
    el("strong", { text: d.nextAction }),
  ]);
  const stepper = el("div", { class: "cp-steps" }, d.stages.map(stageBox));
  const blockers = d.blockers.length
    ? card(
        "Blockers",
        el(
          "div",
          { class: "cp-rows" },
          d.blockers.map((b) =>
            el("div", { class: "cp-row" }, [
              pill("blocker", "danger"),
              el("span", { text: b }),
            ]),
          ),
        ),
      )
    : null;
  return el("div", { class: "view cp-view" }, [
    banner,
    card("Delivery lifecycle", [stepper]),
    blockers,
  ]);
}
