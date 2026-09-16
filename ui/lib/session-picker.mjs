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

export function providerLabel(provider) {
  return provider === "codex" ? "Codex" : "Claude Code";
}

function selection(agent) {
  return {
    id: agent.latestSessionId,
    path: agent.path,
    branch: agent.branch,
    provider: agent.provider || "claude",
  };
}

function sessionKey(agent) {
  return `${agent.provider || "claude"}:${agent.latestSessionId}`;
}

export function pickSession(app, agents) {
  const want = app.store.feedSession;
  const selected = want && agents.find((a) =>
    a.latestSessionId === want.id &&
    (a.provider || "claude") === (want.provider || "claude"),
  );
  if (selected) return selection(selected);
  const active = agents.find((a) => a.active) || agents[0];
  return active ? selection(active) : null;
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
          const a = agents.find((x) => sessionKey(x) === id);
          app.store.feedSession = a ? selection(a) : null;
          app.rerender();
        },
      },
      agents.length
        ? agents.map((a) =>
            el("option", {
              value: sessionKey(a),
              text: `${providerLabel(a.provider)} · ${a.branch || "(detached)"} · ${a.latestSessionId.slice(0, 8)}${a.active ? " · live" : ""}`,
              selected: sel && sessionKey(a) === `${sel.provider || "claude"}:${sel.id}` ? true : null,
            }),
          )
        : [el("option", { value: "", text: "No sessions" })],
    )
  );
}
