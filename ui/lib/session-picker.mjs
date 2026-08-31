// @ts-check
/**
 * Shared session picker for the Activity views. Selection persists in
 * `app.store.feedSession` so Session and Trace stay on the same session.
 */
import { el } from "./dom.mjs";

export function agentsList(app) {
  return (app.snapshot?.sessions?.agents ?? []).filter(
    (a) => a.latestSessionId,
  );
}

export function pickSession(app, agents) {
  const want = app.store.feedSession;
  if (want && agents.some((a) => a.latestSessionId === want.id)) return want;
  const active = agents.find((a) => a.active) || agents[0];
  return active
    ? { id: active.latestSessionId, path: active.path, branch: active.branch }
    : null;
}

/** @returns {HTMLSelectElement} */
export function sessionPicker(app, agents, sel) {
  return /** @type {HTMLSelectElement} */ (
    el(
      "select",
      {
        class: "input",
        onChange: (e) => {
          const id = /** @type {HTMLSelectElement} */ (e.target).value;
          const a = agents.find((x) => x.latestSessionId === id);
          app.store.feedSession = a
            ? { id: a.latestSessionId, path: a.path, branch: a.branch }
            : null;
          app.rerender();
        },
      },
      agents.length
        ? agents.map((a) =>
            el("option", {
              value: a.latestSessionId,
              text: `${a.branch || a.latestSessionId.slice(0, 8)}${a.active ? " · live" : ""}`,
              selected: sel && a.latestSessionId === sel.id ? true : null,
            }),
          )
        : [el("option", { value: "", text: "No sessions" })],
    )
  );
}
