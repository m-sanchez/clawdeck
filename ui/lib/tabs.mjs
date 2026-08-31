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
  const strip = el(
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
  // WAI-ARIA tabs keyboard pattern: arrows move between tabs, selection
  // follows focus (each activation is just a hash navigation).
  strip.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : null;
    if (step == null && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const current = tabs.findIndex((t) => t.id === activeId);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? tabs.length - 1
          : (current + step + tabs.length) % tabs.length;
    app.navigate(`#/${hubKey}/${tabs[next].id}`);
    // The hashchange re-render focuses #main; refocus the tab afterwards so
    // arrow keys keep working without re-tabbing.
    setTimeout(
      () => document.getElementById(`tab-${hubKey}-${tabs[next].id}`)?.focus(),
      0,
    );
  });
  return strip;
}
