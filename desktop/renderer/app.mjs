import "../../ui/ocelin/ocelin-element.mjs";
import {
  groupSessions,
  isRunning,
  needsAttention,
  memory,
  tone,
  statusLabel,
} from "./session-model.mjs";
import { icon, providerIcon } from "./icons.mjs";
import {
  initLibrary,
  attachPreview,
  libraryView,
  showLibrary,
} from "./library.mjs";
const api = window.ocelin;
const $ = (id) => document.getElementById(id);
const surface =
  new URLSearchParams(location.search).get("surface") || "dashboard";
document.body.dataset.surface = surface;
document.title =
  surface === "bar"
    ? "Ocelin · Session bar"
    : surface === "tray"
      ? "Ocelin · Tray panel"
      : "Ocelin";
let state,
  preview,
  rendering = "",
  groupLimit = 60;
const openActions = new Set(),
  rowLimits = new Map();
let collapsed = {};
try {
  const saved = JSON.parse(localStorage.getItem("ocelin.projects") || "{}");
  if (saved && !Array.isArray(saved) && typeof saved === "object")
    collapsed = saved;
} catch {}
const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
const node = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
};
const button = (text, fn, className = "") => {
  const e = node("button", className, text);
  e.type = "button";
  e.addEventListener("click", fn);
  return e;
};
const age = (ts) => {
  const m = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  return m < 1
    ? "now"
    : m < 60
      ? `${m}m`
      : m < 1440
        ? `${Math.floor(m / 60)}h`
        : `${Math.floor(m / 1440)}d`;
};
const cpu = (value) =>
  value == null ? "CPU warming up" : `${value.toFixed(1)}% CPU`;
function saveCollapse() {
  collapsed = Object.fromEntries(Object.entries(collapsed).slice(-300));
  try {
    localStorage.setItem("ocelin.projects", JSON.stringify(collapsed));
  } catch {}
}
async function action(name, args) {
  $("error").hidden = true;
  try {
    return await api.action(name, args);
  } catch (e) {
    $("error").textContent = e.message.replace(
      /^Error invoking remote method '[^']+': Error: /,
      "",
    );
    $("error").hidden = false;
  }
}
function motion() {
  const pref = state?.preferences.motion || "system";
  $("pet").setAttribute(
    "motion",
    document.hidden
      ? "none"
      : pref === "system"
        ? motionQuery.matches
          ? "reduced"
          : "full"
        : pref,
  );
}
function setFilter(filter) {
  if (libraryView() !== "now") void showLibrary("now");
  $("filter").value = filter;
  groupLimit = 60;
  renderSessions();
}
for (const [filter, label] of [
  ["running", "Running"],
  ["attention", "Need you"],
  ["active", "Active projects"],
]) {
  const b = button("", () => setFilter(filter), `count count-${filter}`);
  b.dataset.filter = filter;
  b.append(node("strong", "", "—"), node("span", "", label));
  $("counts").append(b);
}
for (const [id, name] of [
  ["dashboard", "open"],
  ["settings", "settings"],
  ["hide", "hide"],
  ["refresh", "refresh"],
])
  $(id).replaceChildren(icon(name));
if (surface === "bar") {
  $("settings").replaceChildren(icon("open"));
  $("settings").title = "Open dashboard";
  $("settings").setAttribute("aria-label", "Open dashboard");
  $("hide").title = "Hide floating bar";
  $("hide").setAttribute("aria-label", "Hide floating bar");
  document.querySelector(".brand").title = "Drag to move";
}
function render(value) {
  state = value;
  document.documentElement.dataset.theme = value.preferences.theme;
  document.body.dataset.density = value.preferences.density;
  document.body.dataset.barLayout = value.preferences.barLayout || "sessions";
  motion();
  $("pet").setAttribute(
    "state",
    value.counts.attention
      ? "attention"
      : value.counts.running
        ? "coding"
        : "idle",
  );
  $("error").hidden = !value.error;
  if (value.error) $("error").textContent = value.error;
  const counts = {
    running: value.counts.running,
    attention: value.counts.attention,
    active: groupSessions(value.sessions).length,
  };
  for (const b of $("counts").children)
    b.querySelector("strong").textContent = counts[b.dataset.filter];
  $("health").textContent = value.sampledAt
    ? `Activity updated ${age(value.sampledAt)} · on this computer`
    : "Discovering local sessions…";
  for (const input of document.querySelectorAll("[data-pref]")) {
    if (document.activeElement === input) continue;
    if (input.type === "checkbox")
      input.checked = value.preferences[input.dataset.pref];
    else input.value = value.preferences[input.dataset.pref];
  }
  for (const provider of ["codex", "claude"])
    $(`mute-${provider}`).checked =
      value.preferences.mutedProviders.includes(provider);
  $("version").textContent =
    `Ocelin ${value.version} · ${value.packaged ? "Windows desktop" : "Development build"}`;
  $("native-status").textContent =
    value.nativeTasks?.message || "Native taskbar tasks are off";
  $("connection-status").replaceChildren(
    ...["codex", "claude"].map((provider) => {
      const connection = value.connections?.[provider] || {};
      const hook = value.diagnostics.find(
        (d) => d.provider === provider,
      )?.lastHookAt;
      const row = node("p", "connection-row");
      row.append(
        providerIcon(provider),
        node(
          "span",
          "",
          `${provider === "codex" ? "Codex" : "Claude"}: ${connection.nativeOpen ? "app connected" : "Desktop app not detected"} · ${hook ? `hook received ${age(hook)}` : connection.hooksInstalled ? "hooks installed; waiting for provider trust / next event" : "transcripts only; install hooks for lifecycle signals"}`,
        ),
      );
      return row;
    }),
  );
  $("sources").replaceChildren(
    ...value.diagnostics.map((s) =>
      node(
        "p",
        "",
        `${s.provider === "codex" ? "Codex" : "Claude"}: ${s.status} · ${s.files} files${s.capped ? " · discovery limit reached" : ""}\n${s.root}\n${s.lastHookAt ? `Last hook ${age(s.lastHookAt)}` : "Transcript inference; no hook received yet"}`,
      ),
    ),
  );
  renderResources();
  renderSessions();
}
function renderResources() {
  const r = state.resources;
  const fresh = r?.status === "ready" && Date.now() - r.sampledAt < 35000;
  for (const provider of ["codex", "claude", "ocelin"]) {
    let b = $("resources").querySelector(`[data-provider="${provider}"]`);
    if (!b) {
      b = button("", openResources, "resource");
      b.dataset.provider = provider;
      b.append(
        providerIcon(provider),
        node(
          "span",
          "resource-name",
          provider === "codex"
            ? "Codex"
            : provider === "claude"
              ? "Claude"
              : "Ocelin",
        ),
        node("strong", "resource-value"),
        node("span", "resource-extra"),
      );
      $("resources").append(b);
    }
    const g = r?.groups?.find((g) => g.provider === provider);
    b.querySelector("strong").textContent = fresh
      ? memory(g?.memoryBytes)
      : "—";
    b.querySelector(".resource-extra").textContent =
      fresh && g
        ? `${g.processCount} processes · ${cpu(g.cpuPercent)}${g.unavailable ? " · partial" : ""}`
        : r?.status === "loading"
          ? "Measuring RAM…"
          : "Memory unavailable";
    b.title =
      "Private working set: physical RAM used only by these processes. Click for details.";
  }
  const groups = (r?.groups || []).filter((g) => g.provider !== "ocelin");
  const complete =
    groups.length > 0 &&
    groups.every((g) => Number.isFinite(g.memoryBytes) && !g.unavailable);
  const total =
    fresh && complete
      ? memory(groups.reduce((n, g) => n + g.memoryBytes, 0))
      : "—";
  $("compact-summary").replaceChildren(
    node(
      "strong",
      "",
      `${state.counts.running} running${state.counts.attention ? ` · ${state.counts.attention} need you` : ""}`,
    ),
    node("span", "", `Codex + Claude · ${total} RAM`),
  );
  const signature = JSON.stringify([r?.sampledAt, fresh]);
  if (
    $("resource-dialog").open &&
    $("resource-processes").dataset.signature !== signature
  ) {
    const previousOpen = new Map(
      [...$("resource-processes").children].map((d) => [
        d.dataset.provider,
        d.open,
      ]),
    );
    $("resource-processes").dataset.signature = signature;
    $("resource-processes").replaceChildren(
      ...(r?.groups || []).map((g) => {
        const details = node("details", "process-group");
        details.dataset.provider = g.provider;
        details.open = previousOpen.get(g.provider) ?? true;
        const summary = node("summary");
        summary.append(
          providerIcon(g.provider),
          node(
            "strong",
            "",
            `${g.provider === "codex" ? "Codex" : g.provider === "claude" ? "Claude" : "Ocelin"} · ${fresh ? memory(g.memoryBytes) : "Unavailable"}`,
          ),
          node("span", "", `${g.processCount} processes`),
        );
        details.append(summary);
        const table = node("table");
        const head = node("tr");
        for (const label of ["Process", "PID", "RAM", "CPU"])
          head.append(node("th", "", label));
        table.append(head);
        for (const p of g.processes) {
          const row = node("tr");
          for (const text of [
            p.name,
            p.pid,
            fresh ? memory(p.memoryBytes) : "—",
            fresh && p.cpuPercent != null ? `${p.cpuPercent.toFixed(1)}%` : "—",
          ])
            row.append(node("td", "", text));
          table.append(row);
        }
        details.append(table);
        return details;
      }),
    );
  }
  $("resource-health").textContent = fresh
    ? `Sampled ${age(r.sampledAt)} · refreshes every 12 seconds. Inaccessible processes are marked unavailable. CPU is normalized across all logical processors.`
    : r?.message || "Measuring Windows processes…";
}
async function openSession(s, b) {
  b.disabled = true;
  await action("session-open", { key: s.key });
  b.disabled = false;
}
function sessionRow(s) {
  const row = node("article", "session");
  row.dataset.key = s.key;
  row.dataset.tone = tone(s);
  row.dataset.attention = String(Boolean(needsAttention(s)));
  const title = button(
    s.displayTitle || `Session ${s.sessionId.slice(0, 8)}`,
    () => openSession(s, title),
    "session-title",
  );
  title.dataset.focus = `open:${s.key}`;
  title.setAttribute(
    "aria-label",
    `Open ${s.provider} session: ${s.displayTitle || s.title}`,
  );
  title.title = `${s.displayTitle || s.title}\n${s.sessionId}`;
  const label = node("div", "session-name");
  label.append(title);
  if (s.parentId) label.append(node("span", "subagent", "↳ subagent"));
  const status = node("span", "status", statusLabel(s));
  status.title = `${s.label}\n${s.quality === "hook" ? "Lifecycle hook" : "Inferred from transcript"}`;
  const timestamp = node("time", "age", age(s.lastTs));
  timestamp.dateTime = new Date(s.lastTs).toISOString();
  timestamp.title = `Last activity: ${new Date(s.lastTs).toLocaleString()}`;
  const details = node("details", "session-actions");
  details.open = openActions.has(s.key);
  const summary = node("summary", "action-menu");
  summary.append(icon("more"));
  summary.title = "Session details and actions";
  summary.setAttribute(
    "aria-label",
    `Details for ${s.displayTitle || s.title}`,
  );
  summary.dataset.focus = `details:${s.key}`;
  const menu = node("div", "action-panel");
  menu.append(
    node(
      "div",
      "",
      `${s.provider === "codex" ? "Codex" : "Claude"} · ${s.sessionId}`,
    ),
    node(
      "div",
      "source",
      `${s.quality === "hook" ? "Lifecycle hook" : "Transcript inference"} · ${s.stale ? "status may be stale" : "recent activity"}`,
    ),
  );
  const actions = node("div", "buttons");
  actions.append(button("Open folder", () => action("folder", { key: s.key })));
  actions.append(
    button("Project dashboard", () => action("project", { key: s.key })),
  );
  if (s.unseen)
    actions.append(
      button("Mark seen", () => action("acknowledge", { key: s.key })),
    );
  actions.append(
    button(
      state.preferences.mutedProjects.includes(s.cwd)
        ? "Unmute project"
        : "Mute project",
      () => action("mute-project", { key: s.key }),
    ),
  );
  menu.append(actions);
  details.append(summary, menu);
  details.addEventListener("toggle", () => {
    if (!details.isConnected) return;
    details.open ? openActions.add(s.key) : openActions.delete(s.key);
  });
  row.append(providerIcon(s.provider), label, status, timestamp, details);
  attachPreview(row, s);
  return row;
}
function renderSessions() {
  if (!state) return;
  const filter = $("filter").value;
  const groups = groupSessions(
    state.sessions.filter(
      (s) =>
        !state.hiddenKeys?.includes(s.key) || isRunning(s) || needsAttention(s),
    ),
    {
      search: $("search").value,
      filter,
      historySince: state.preferences.historySince,
    },
  );
  $("list-title").textContent =
    `${groups.length} ${groups.length === 1 ? "project" : "projects"}`;
  for (const b of $("counts").children)
    b.setAttribute("aria-pressed", String(b.dataset.filter === filter));
  const signature = JSON.stringify([
    groups,
    filter,
    collapsed,
    [...rowLimits],
    state.preferences.mutedProjects,
    groupLimit,
    Math.floor(Date.now() / 60000),
  ]);
  if (signature === rendering) return;
  rendering = signature;
  const focus = document.activeElement?.dataset.focus;
  const rows = [];
  if (surface === "bar") {
    const sessions = groups
      .flatMap((g) => g.sessions)
      .sort(
        (a, b) =>
          Number(Boolean(needsAttention(b))) -
            Number(Boolean(needsAttention(a))) ||
          Number(isRunning(b)) - Number(isRunning(a)) ||
          b.lastTs - a.lastTs,
      );
    for (const s of sessions.slice(0, 5)) {
      const b = button("", () => openSession(s, b), "session chip");
      b.dataset.tone = tone(s);
      b.dataset.key = s.key;
      b.dataset.focus = `chip:${s.key}`;
      const text = node("span");
      text.append(
        node("strong", "", s.title),
        node("span", "status", statusLabel(s)),
      );
      b.append(providerIcon(s.provider), text);
      b.title = `${s.provider}: ${s.displayTitle || s.title}\n${s.label}`;
      rows.push(b);
    }
    if (sessions.length > 5)
      rows.push(
        button(
          `+${sessions.length - 5}`,
          () => action("show", { surface: "dashboard" }),
          "overflow",
        ),
      );
  } else {
    for (const g of groups.slice(0, groupLimit)) {
      const group = node("details", "project-group");
      group.dataset.project = g.key;
      group.open = Object.hasOwn(collapsed, g.key)
        ? !collapsed[g.key]
        : g.running > 0 || g.attention > 0 || groups.length === 1;
      const summary = node("summary", "project-heading");
      summary.dataset.focus = `group:${g.key}`;
      summary.title = g.cwd;
      summary.append(
        icon("chevron"),
        icon("folder"),
        node("strong", "project-title", g.title),
      );
      const providers = node("span", "project-providers");
      for (const p of ["codex", "claude"]) {
        const n = g.sessions.filter((s) => s.provider === p).length;
        if (n) {
          const mark = node("span");
          mark.append(providerIcon(p), node("span", "", String(n)));
          providers.append(mark);
        }
      }
      summary.append(
        providers,
        node(
          "span",
          "project-count",
          `${g.sessions.length} ${g.sessions.length === 1 ? "session" : "sessions"}`,
        ),
      );
      if (g.attention)
        summary.append(
          node("span", "group-signal attention", `${g.attention} need you`),
        );
      if (g.running)
        summary.append(
          node("span", "group-signal running", `${g.running} running`),
        );
      group.append(summary);
      const list = node("div", "project-sessions");
      const fill = () => {
        const limit = rowLimits.get(g.key) || 40;
        list.replaceChildren(...g.sessions.slice(0, limit).map(sessionRow));
        if (g.sessions.length > limit)
          list.append(
            button(
              `Show ${Math.min(40, g.sessions.length - limit)} more sessions`,
              () => {
                rowLimits.set(g.key, limit + 40);
                rendering = "";
                renderSessions();
              },
              "load-more",
            ),
          );
      };
      if (group.open) fill();
      group.append(list);
      group.addEventListener("toggle", () => {
        if (!group.isConnected) return;
        collapsed[g.key] = !group.open;
        saveCollapse();
        if (group.open && !list.children.length) fill();
      });
      rows.push(group);
    }
    if (groups.length > groupLimit)
      rows.push(
        button(
          `Show more projects (${groups.length - groupLimit} remaining)`,
          () => {
            groupLimit += 60;
            rendering = "";
            renderSessions();
          },
          "load-more",
        ),
      );
  }
  if (!rows.length) {
    const empty = node("div", "empty");
    empty.append(
      node(
        "strong",
        "",
        state.sampledAt
          ? "No sessions match this view"
          : "Finding your agents…",
      ),
      node(
        "span",
        "",
        filter === "active"
          ? "No recent running or attention signals. Open apps can still use RAM."
          : "Try a different filter or search.",
      ),
    );
    if (filter !== "all")
      empty.append(
        button(
          "Browse saved conversations",
          () => showLibrary("history"),
          "text-button",
        ),
      );
    rows.push(empty);
  }
  $("sessions").replaceChildren(...rows);
  $("collapse").textContent = rows.some(
    (row) => row.matches(".project-group") && row.open,
  )
    ? "Collapse all"
    : "Expand all";
  if (focus && document.hasFocus())
    $("sessions")
      .querySelector(`[data-focus="${CSS.escape(focus)}"]`)
      ?.focus({ preventScroll: true });
}
$("collapse").addEventListener("click", () => {
  const groups = groupSessions(state.sessions, {
    search: $("search").value,
    filter: $("filter").value,
    historySince: state.preferences.historySince,
  });
  const allClosed = ![...$("sessions").querySelectorAll(".project-group")].some(
    (g) => g.open,
  );
  for (const g of groups) collapsed[g.key] = !allClosed;
  $("collapse").textContent = allClosed ? "Collapse all" : "Expand all";
  saveCollapse();
  rendering = "";
  renderSessions();
});
function openResources() {
  $("resource-dialog").showModal();
  renderResources();
}
$("memory-details").addEventListener("click", openResources);
$("clear-history").addEventListener("click", async () => {
  const result = await action("preferences", { historySince: Date.now() });
  if (result)
    $("history-result").textContent =
      "Older finished and stale entries are hidden. New activity brings them back.";
});
$("restore-history").addEventListener("click", async () => {
  const result = await action("preferences", { historySince: 0 });
  if (result)
    $("history-result").textContent =
      "Older sessions are available in the history filters again.";
});
$("export-widget").addEventListener("click", () => action("export-widget"));
$("install-widget").addEventListener("click", () => action("install-widget"));
$("taskbar-guide").addEventListener("click", () => action("taskbar-guide"));
$("compact-summary").addEventListener("click", () =>
  action("show", { surface: "dashboard" }),
);
$("search").addEventListener("input", renderSessions);
$("filter").addEventListener("change", renderSessions);
$("refresh").addEventListener("click", () => action("refresh"));
$("dashboard").addEventListener("click", () =>
  action("show", { surface: "dashboard" }),
);
$("hide").addEventListener("click", () => action("hide", { surface }));
$("settings").addEventListener("click", async () => {
  if (surface === "bar") {
    await action("show", { surface: "dashboard" });
    return;
  }
  $("preferences").showModal();
});
$("quit").addEventListener("click", () => action("quit"));
for (const input of document.querySelectorAll("[data-pref]"))
  input.addEventListener("change", () =>
    action("preferences", {
      [input.dataset.pref]:
        input.type === "checkbox" ? input.checked : input.value,
    }),
  );
for (const provider of ["codex", "claude"])
  $(`mute-${provider}`).addEventListener("change", () =>
    action("preferences", {
      mutedProviders: ["codex", "claude"].filter((p) => $(`mute-${p}`).checked),
    }),
  );
for (const b of document.querySelectorAll("[data-source]"))
  b.addEventListener("click", () =>
    action("source", { provider: b.dataset.source }),
  );
for (const provider of ["codex", "claude"]) {
  const row = node("div", "buttons");
  for (const remove of [false, true])
    row.append(
      button(
        `${remove ? "Remove" : "Preview"} ${provider === "codex" ? "Codex" : "Claude"} hooks`,
        async () => {
          preview = await action("hook-preview", { provider, remove });
          if (!preview) return;
          $("hook-note").textContent = `${preview.handler} ${preview.note}`;
          $("hook-file").textContent = preview.file;
          $("hook-json").textContent = JSON.stringify(
            { before: preview.before, after: preview.after },
            null,
            2,
          );
          $("hook-result").textContent = "";
          $("hook-apply").disabled = false;
          $("hook-dialog").showModal();
        },
      ),
    );
  $("integrations").append(row);
}
$("hook-apply").addEventListener("click", async () => {
  const result = await action("hook-apply", { id: preview?.id });
  if (result) {
    $("hook-apply").disabled = true;
    $("hook-result").textContent =
      `Applied. Backup: ${result.backup}. ${preview.note}`;
  }
});
motionQuery.addEventListener("change", motion);
document.addEventListener("visibilitychange", motion);
initLibrary(action, renderSessions);
api.subscribe(render);
render(await api.state());
