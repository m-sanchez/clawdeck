// @ts-check
/**
 * Session viewer: mirrors a Claude Code session's transcript the way the CLI
 * renders it (user prompts, assistant text, thinking markers, tool calls with
 * their results). Picks any session the panel can see and polls its feed while
 * the view is open. Read-only.
 */
import { el, card, clear, relTime, emptyState } from "../lib/dom.mjs";
import {
  agentsList,
  pickSession,
  sessionPicker,
} from "../lib/session-picker.mjs";

const POLL_MS = 4000;
let pollTimer = null;

export function render(app) {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  const agents = agentsList(app);
  const sel = pickSession(app, agents);

  const picker = sessionPicker(app, agents, sel);

  const meta = el("div", { class: "feed-meta small muted" });
  const feedHost = el("div", { class: "feed-stream" }, [
    el("div", { class: "df-running" }, [
      el("span", { class: "spinner-inline" }),
      el("span", { class: "muted small", text: "Loading transcript…" }),
    ]),
  ]);

  const refresh = () => {
    if (!sel) return;
    app.api
      .sessionFeed(sel.id, sel.path || undefined)
      .then((d) => {
        if (!feedHost.isConnected) {
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          return;
        }
        renderMeta(meta, sel, d);
        renderFeed(feedHost, d);
      })
      .catch((e) => {
        if (feedHost.isConnected)
          clear(feedHost).append(errBox(String((e && e.message) || e)));
      });
  };

  if (sel) {
    refresh();
    pollTimer = setInterval(refresh, POLL_MS);
  } else {
    clear(feedHost).append(
      emptyState(
        "No sessions to show.",
        "Sessions appear here as Claude Code works in this checkout or its worktrees.",
      ),
    );
  }

  return el("div", { class: "view view-session" }, [
    card(
      "Session viewer",
      [
        el("p", {
          class: "muted small",
          text: "A live mirror of a Claude Code session's transcript: prompts, replies, and tool calls with their results. Read-only.",
        }),
        el("div", { class: "feed-controls" }, [
          el("label", { class: "field" }, [
            el("span", { class: "field-label", text: "Session" }),
            picker,
          ]),
          meta,
        ]),
        feedHost,
      ],
      {
        help: "Reads the tail of the session's transcript file and renders it like the CLI. Refreshes every few seconds while open.",
      },
    ),
  ]);
}

function renderMeta(host, sel, d) {
  clear(host);
  const last = (d.events || []).at(-1);
  host.append(
    el("span", { class: "feed-live" }, [
      el("span", { class: "agent-dot on" }),
      el("span", { text: "live" }),
    ]),
    el("span", { class: "mono", text: d.model || "claude" }),
    el("span", { text: sel.branch || d.branch || "" }),
    el("span", {
      text: last?.ts
        ? `updated ${relTime(last.ts)}`
        : `${(d.events || []).length} events`,
    }),
  );
}

const GUTTER = { user: ">", assistant: "●", thinking: "✻", tool: "⏺" };

function renderFeed(host, d) {
  clear(host);
  if (d.missing) {
    host.append(
      emptyState(
        "Transcript not found.",
        "This session has no transcript file under ~/.claude/projects for this checkout.",
      ),
    );
    return;
  }
  const events = d.events || [];
  if (!events.length) {
    host.append(
      emptyState("No recent activity.", "The transcript tail was empty."),
    );
    return;
  }
  const stickToBottom =
    host.scrollHeight - host.scrollTop - host.clientHeight < 80;
  const frag = events.map(feedRow);
  host.replaceChildren(...frag);
  if (stickToBottom) host.scrollTop = host.scrollHeight;
}

function feedRow(e) {
  if (e.kind === "tool") return toolRow(e);
  if (e.kind === "result") return resultLine(e, true);
  const gutter = GUTTER[e.kind] || "·";
  const text = e.kind === "thinking" ? e.text || "thinking" : e.text || "";
  return el("div", { class: `feed-row fr-${e.kind}` }, [
    el("span", { class: "feed-gutter", text: gutter }),
    el("div", { class: "feed-body", text }),
  ]);
}

function toolRow(e) {
  const children = [
    el("div", { class: "feed-row fr-tool" }, [
      el("span", { class: "feed-gutter", text: GUTTER.tool }),
      el("div", { class: "feed-body" }, [
        el("span", { class: "feed-tool-name", text: e.tool }),
        e.summary
          ? el("span", { class: "feed-tool-arg mono", text: `(${e.summary})` })
          : null,
      ]),
    ]),
  ];
  if (e.result) children.push(resultLine(e.result, false));
  return el("div", { class: "feed-tool-group" }, children);
}

function resultLine(res, standalone) {
  const tail = res.lines > 1 ? ` · ${res.lines} lines` : "";
  return el(
    "div",
    {
      class: `feed-result ${res.ok ? "" : "err"} ${standalone ? "standalone" : ""}`,
    },
    [
      el("span", { class: "feed-gutter", text: "⎿" }),
      el("div", { class: "feed-result-body mono small" }, [
        el("span", {
          class: "feed-result-text",
          text: res.preview || "(no output)",
        }),
        tail ? el("span", { class: "muted", text: tail }) : null,
      ]),
    ],
  );
}

function errBox(msg) {
  return el("div", { class: "inspector-error" }, [
    el("strong", { text: "Error" }),
    el("div", { class: "muted small", text: msg }),
  ]);
}
