// @ts-check
/** A tab strip for a hub view. Each tab deep-links to #/<hub>/<tabId>. */
import { el } from "./dom.mjs";

/**
 * @param {any} app
 * @param {string} hubKey
 * @param {{ id: string, label: string }[]} tabs
 * @param {string} activeId
 */
export function tabStrip(app, hubKey, tabs, activeId) {
  return el(
    "div",
    { class: "tabstrip", role: "tablist" },
    tabs.map((t) =>
      el("button", {
        class: `tab ${t.id === activeId ? "active" : ""}`,
        type: "button",
        role: "tab",
        id: `tab-${hubKey}-${t.id}`,
        "aria-controls": `panel-${hubKey}`,
        "aria-selected": t.id === activeId ? "true" : "false",
        text: t.label,
        onClick: () => app.navigate(`#/${hubKey}/${t.id}`),
      }),
    ),
  );
}
