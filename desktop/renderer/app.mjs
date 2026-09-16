import "../../ui/ocelin/ocelin-element.mjs";

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
  rendering = "";
const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
const node = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
};
const button = (text, fn) => {
  const e = node("button", "", text);
  e.type = "button";
  e.addEventListener("click", fn);
  return e;
};
const age = (ts) => {
  const min = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  return min < 1
    ? "just now"
    : min < 60
      ? `${min}m ago`
      : min < 1440
        ? `${Math.floor(min / 60)}h ago`
        : `${Math.floor(min / 1440)}d ago`;
};
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
function render(value) {
  state = value;
  document.documentElement.dataset.theme = value.preferences.theme;
  document.body.dataset.density = value.preferences.density;
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
  $("counts").replaceChildren(
    ...[
      ["Running", value.counts.running],
      ["Need you", value.counts.attention],
      ["Discovered", value.sessions.length],
    ].map(([label, count]) => {
      const e = node("div");
      e.append(node("strong", "", String(count)), node("span", "", label));
      return e;
    }),
  );
  $("health").textContent = value.sampledAt
    ? `Updated ${age(value.sampledAt)} · one shared monitor`
    : "Discovering local sessions…";
  for (const input of document.querySelectorAll("[data-pref]")) {
    if (input.type === "checkbox")
      input.checked = value.preferences[input.dataset.pref];
    else input.value = value.preferences[input.dataset.pref];
  }
  for (const provider of ["codex", "claude"])
    $(`mute-${provider}`).checked =
      value.preferences.mutedProviders.includes(provider);
  $("version").textContent =
    `Ocelin ${value.version} · ${value.packaged ? "Windows desktop" : "Development build"}`;
  $("sources").replaceChildren(
    ...value.diagnostics.map((s) =>
      node(
        "p",
        "",
        `${s.provider === "codex" ? "Codex" : "Claude"}: ${s.status} · ${s.files} files${s.capped ? " · discovery limit reached" : ""}\n${s.root}\n${s.lastHookAt ? `Last hook ${age(s.lastHookAt)}` : "Transcript inference; no hook received yet"}`,
      ),
    ),
  );
  renderSessions();
}
function renderSessions() {
  if (!state) return;
  const search = $("search").value.toLowerCase();
  const filter = $("filter").value;
  let sessions = state.sessions.filter((s) =>
    `${s.title} ${s.displayTitle || ""} ${s.cwd} ${s.sessionId} ${s.provider}`
      .toLowerCase()
      .includes(search),
  );
  if (filter === "attention")
    sessions = sessions.filter(
      (s) => s.attention || s.execution === "error" || s.unseen,
    );
  if (filter === "recent")
    sessions = sessions.filter(
      (s) => !s.stale || Date.now() - s.lastTs < 24 * 60 * 60 * 1000,
    );
  const count = sessions.length;
  sessions = sessions.slice(0, surface === "bar" ? 5 : 150);
  const signature = JSON.stringify([
    sessions,
    state.preferences.mutedProjects,
    Math.floor(Date.now() / 60000),
  ]);
  if (signature === rendering) return;
  rendering = signature;
  const rows = sessions.map((s) => {
    const card = node("article", "session");
    card.dataset.key = s.key;
    card.dataset.attention = String(Boolean(s.attention));
    const top = node("div", "session-top");
    top.append(
      node("span", "provider", s.provider === "codex" ? "Codex" : "Claude"),
      node("span", "id", s.sessionId.slice(0, 8)),
    );
    card.append(
      top,
      node("h3", "", s.displayTitle || s.title),
      node(
        "div",
        "detail",
        `${s.title}${s.parentId ? ` · subagent of ${s.parentId.split(":")[1].slice(0, 8)}` : s.host ? ` · ${s.host}` : ""}`,
      ),
      node("div", "status", s.label),
      node(
        "div",
        "source",
        `${s.quality === "hook" ? "Lifecycle hook" : s.quality === "stale" ? "Stale activity; outcome unknown" : "Transcript inference"} · ${age(s.lastTs)}`,
      ),
    );
    card.title = `${s.cwd}\n${s.sessionId}\n${s.label}`;
    const buttons = node("div", "buttons");
    const open = button("Project dashboard", async () => {
      open.disabled = true;
      open.textContent = "Opening…";
      await action("project", { key: s.key });
      open.disabled = false;
      open.textContent = "Project dashboard";
    });
    buttons.append(
      open,
      button("Folder", () => action("folder", { key: s.key })),
    );
    if (s.unseen)
      buttons.append(
        button("Seen", () => action("acknowledge", { key: s.key })),
      );
    buttons.append(
      button(
        state.preferences.mutedProjects.includes(s.cwd) ? "Unmute" : "Mute",
        () => action("mute-project", { key: s.key }),
      ),
    );
    card.append(buttons);
    if (surface === "bar") {
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute(
        "aria-label",
        `${s.provider} ${s.title}: ${s.label}. Open project dashboard`,
      );
      card.addEventListener("click", () => action("project", { key: s.key }));
      card.addEventListener("keydown", (e) => {
        if (["Enter", " "].includes(e.key)) {
          e.preventDefault();
          action("project", { key: s.key });
        }
      });
    }
    return card;
  });
  if (!rows.length) {
    const empty = node("div", "empty");
    empty.append(
      node(
        "strong",
        "",
        state.sampledAt ? "All quiet here." : "Finding your agents…",
      ),
      node(
        "span",
        "",
        state.sampledAt
          ? "Start a local Codex or Claude session, change the filter, or check Sources in settings."
          : "Reading local activity without changing your sessions.",
      ),
    );
    rows.push(empty);
  }
  if (count > sessions.length)
    rows.push(
      button(`+${count - sessions.length} more`, () =>
        action("show", { surface: "dashboard" }),
      ),
    );
  const focused = document.activeElement;
  const previousCard = focused?.closest(".session");
  const buttonIndex = previousCard
    ? [...previousCard.querySelectorAll("button")].indexOf(focused)
    : -1;
  const previousKey = previousCard?.dataset.key;
  $("sessions").replaceChildren(...rows);
  if (previousKey && document.hasFocus()) {
    const card = $("sessions").querySelector(
      `[data-key="${CSS.escape(previousKey)}"]`,
    );
    (buttonIndex >= 0
      ? card?.querySelectorAll("button")[buttonIndex]
      : card
    )?.focus({ preventScroll: true });
  }
}
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
api.subscribe(render);
render(await api.state());
