// @ts-check
/**
 * Agent tree: which subagents a session spawned, nested by who spawned whom,
 * with each agent's own closing report.
 *
 * Two rules shape what is shown. An edge only appears where a record proves it,
 * so an agent whose creating Task call is in no transcript we hold is listed
 * apart as unattributed rather than quietly parented to the session. And the
 * report text is the agent's own words, labelled as such - nothing here
 * summarizes an agent, because a summary would be a different kind of claim.
 */
import { el, card, clear, relTime, emptyState, pill } from "../lib/dom.mjs";
import {
  agentsList,
  pickSession,
  sessionPicker,
} from "../lib/session-picker.mjs";

const POLL_MS = 6000;
let pollTimer = null;

const compact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
};

function fmtMs(ms) {
  if (ms == null) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  return m < 60
    ? `${m}m ${Math.round((ms % 60000) / 1000)}s`
    : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function render(app) {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!(app.store.agentOpen instanceof Set)) app.store.agentOpen = new Set();

  const agents = agentsList(app);
  const sel = pickSession(app, agents);
  const meta = el("div", { class: "feed-meta small muted" });
  const host = el("div", { class: "agent-host" }, [
    el("div", { class: "df-running" }, [
      el("span", { class: "spinner-inline" }),
      el("span", { class: "muted small", text: "Loading agents…" }),
    ]),
  ]);

  const refresh = () => {
    if (!sel) return;
    app.api
      .subagents(sel.id, sel.path || undefined)
      .then((tree) => {
        if (!host.isConnected) {
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          return;
        }
        renderMeta(meta, tree);
        renderTree(app, host, tree);
      })
      .catch((e) => {
        if (host.isConnected)
          clear(host).append(
            emptyState(
              "Agent tree unavailable.",
              String((e && e.message) || e),
            ),
          );
      });
  };

  if (sel) {
    refresh();
    pollTimer = setInterval(refresh, POLL_MS);
  } else {
    clear(host).append(
      emptyState(
        "No sessions to inspect.",
        "Sessions appear here as Claude Code works in this checkout or its worktrees.",
      ),
    );
  }

  return el("div", { class: "view view-agents" }, [
    card(
      "Agent tree",
      [
        el("p", {
          class: "muted small",
          text: "Subagents this session spawned, nested by who spawned whom. Each agent's report is its own closing message, quoted, never a summary.",
        }),
        el("div", { class: "feed-controls" }, [
          sessionPicker(app, agents, sel),
          meta,
        ]),
        host,
      ],
      {
        help: "Read from the sidecar records Claude Code writes beside a session transcript. An agent is only linked to a parent when a transcript actually contains the Task call that created it; anything unprovable is listed as unattributed.",
      },
    ),
  ]);
}

function renderMeta(node, tree) {
  clear(node);
  if (tree?.missing) {
    node.append(el("span", { text: "no subagents recorded" }));
    return;
  }
  const parts = [
    `${tree.agents.length} agent(s)`,
    `depth ${tree.maxDepth}`,
    `${compact(tree.totals?.output ?? 0)} output tok`,
  ];
  node.append(el("span", { text: parts.join(" · ") }));
  if (tree.truncated) node.append(pill("truncated", "warn"));
  if (tree.unknownParents)
    node.append(pill(`${tree.unknownParents} unattributed`, "neutral"));
}

function renderTree(app, host, tree) {
  clear(host);
  if (tree?.missing || !tree.agents.length) {
    host.append(
      emptyState(
        "This session spawned no subagents.",
        "Agents appear here when a session delegates work with the Task tool.",
      ),
    );
    return;
  }

  const children = new Map();
  for (const a of tree.agents) {
    if (!a.parentKnown) continue;
    const key = a.parentId ?? "session";
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(a);
  }

  const list = el("div", { class: "agent-tree" });
  for (const a of children.get("session") || [])
    list.append(agentNode(app, a, children, 0));
  host.append(list);

  const orphans = tree.agents.filter((a) => !a.parentKnown);
  if (orphans.length) {
    host.append(
      el("p", {
        class: "muted small agent-orphan-note",
        text: "Unattributed: the Task call that created these is in no transcript held here, so no parent is claimed.",
      }),
    );
    const oList = el("div", { class: "agent-tree" });
    for (const a of orphans) oList.append(agentNode(app, a, children, 0));
    host.append(oList);
  }
}

function agentNode(app, agent, children, depth) {
  const open = app.store.agentOpen.has(agent.id);
  const kids = children.get(agent.id) || [];
  const wrap = el("div", {
    class: "agent-node",
    style: `margin-left:${depth * 18}px`,
  });

  const running = !agent.result;
  const head = el("button", {
    class: "agent-head",
    type: "button",
    "aria-expanded": String(open),
    "aria-label": `${agent.agentType || "agent"}: ${open ? "collapse" : "expand"} report`,
    onClick: () => {
      if (open) app.store.agentOpen.delete(agent.id);
      else app.store.agentOpen.add(agent.id);
      app.rerender();
    },
  });
  // `append` stringifies null, unlike el()'s children handling, so absent
  // pieces are filtered out rather than passed through.
  head.append(
    ...[
    el("span", { class: "agent-caret", text: open ? "▾" : "▸" }),
    pill(agent.agentType || "agent", running ? "warn" : "info"),
    el("span", {
      class: "agent-desc",
      text: agent.description || "(no description)",
    }),
    el("span", { class: "muted small", text: fmtMs(agent.durMs) }),
    el("span", {
      class: "mono small muted",
      text: agent.usage
        ? `${compact(agent.usage.output)} out`
        : "usage unknown",
    }),
    agent.startedAt
      ? el("span", { class: "muted small", text: relTime(agent.startedAt) })
      : null,
    running ? pill("no report yet", "warn") : null,
    ].filter(Boolean),
  );
  wrap.append(head);

  if (open) {
    const body = el("div", { class: "agent-body" });
    if (agent.result) {
      body.append(
        el("div", { class: "agent-report-head" }, [
          pill("agent's own words", "neutral"),
          el("span", {
            class: "muted small",
            text: agent.result.closed
              ? "closing report"
              : "latest message, not a conclusion",
          }),
        ]),
      );
      body.append(
        el("pre", { class: "agent-report", text: agent.result.text }),
      );
    } else {
      body.append(
        el("p", {
          class: "muted small",
          text: "No closing message recorded yet. Nothing is inferred about how it went.",
        }),
      );
    }
    if (agent.model)
      body.append(el("p", { class: "mono small muted", text: agent.model }));
    wrap.append(body);
  }

  for (const kid of kids) wrap.append(agentNode(app, kid, children, depth + 1));
  return wrap;
}
