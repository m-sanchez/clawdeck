import { memory } from "./session-model.mjs";
import { providerIcon } from "./icons.mjs";
const diskSize = (bytes) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${Math.ceil(bytes / 1024)} KB`
      : memory(bytes);
const node = (tag, text, cls) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (cls) element.className = cls;
  return element;
};
const button = (label, action, cls) => {
  const b = node("button", label, cls);
  b.type = "button";
  b.addEventListener("click", action);
  return b;
};
export function initDoctor(action, getState, onChange) {
  const dialog = node("dialog", null, "doctor-dialog");
  dialog.id = "doctor-dialog";
  dialog.setAttribute("aria-labelledby", "doctor-title");
  const header = node("header"),
    title = node("h2", "Doctor");
  title.id = "doctor-title";
  const close = button("×", () => dialog.close());
  close.setAttribute("aria-label", "Close Doctor");
  header.append(title, close);
  const body = node("div", null, "doctor-body"),
    status = node("p", "", "muted");
  status.id = "doctor-status";
  status.setAttribute("role", "status");
  const history = node("section", null, "doctor-card");
  const age = node("select");
  age.id = "doctor-age";
  age.setAttribute("aria-label", "Tidy sessions older than");
  for (const days of [30, 90, 180]) {
    const option = node("option", `${days} days`);
    option.value = days;
    age.append(option);
  }
  const ageLabel = node("label", "Older than ");
  ageLabel.append(age);
  const summary = node("p", "Checking saved sessions…");
  summary.id = "doctor-summary";
  const tidy = button("Tidy safely", () => run("tidy"), "primary");
  tidy.id = "doctor-tidy";
  tidy.disabled = true;
  const undo = button("Undo history tidy", () => run("undo"));
  undo.id = "doctor-undo";
  undo.disabled = true;
  const buttons = node("div", null, "buttons");
  buttons.append(tidy, undo);
  history.append(
    node("h3", "Clear the clutter"),
    ageLabel,
    summary,
    node(
      "p",
      "Hides old inactive sessions in Ocelin and removes Ocelin workspace caches older than 7 days. Conversations, projects and sign-ins stay intact. History hiding can be undone; cache removal does not stop apps.",
      "muted",
    ),
    buttons,
  );
  const apps = node("section", null, "doctor-card");
  const appRows = node("div");
  appRows.id = "doctor-apps";
  apps.append(
    node("h3", "Apps using memory"),
    node(
      "p",
      "RAM is shared across an app and its tools. Stopping an app interrupts its sessions; it is never part of Tidy safely.",
      "muted",
    ),
    appRows,
  );
  const release = button("Release Ocelin workspace & index", async () => {
    release.disabled = true;
    try {
      await action("doctor-release");
      status.textContent =
        "Closed Ocelin’s full workspace and unloaded its history index. Session monitoring continues. Open workspace or History to load them again.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      release.disabled = false;
    }
  });
  release.id = "doctor-release";
  const own = node("section", null, "doctor-card");
  own.append(
    node("h3", "Reduce Ocelin’s memory"),
    node(
      "p",
      "Close its full project window and unload the history index. Your coding apps keep running.",
      "muted",
    ),
    release,
  );
  const refresh = button("Refresh scan", () => run("report"));
  refresh.id = "doctor-refresh";
  body.append(
    node(
      "p",
      "A quick check of saved history, temporary workspace data and running apps.",
    ),
    history,
    apps,
    own,
    refresh,
    status,
  );
  dialog.append(header, body);
  document.body.append(dialog);

  const confirm = node("dialog", null, "doctor-dialog");
  confirm.id = "doctor-stop-dialog";
  confirm.setAttribute("aria-labelledby", "doctor-stop-title");
  const stopTitle = node("h2");
  stopTitle.id = "doctor-stop-title";
  const stopText = node("p"),
    stopState = node("p");
  stopState.setAttribute("role", "status");
  let plan;
  const stopApply = button(
    "Stop app and tools",
    async () => {
      stopApply.disabled = true;
      try {
        const result = await action("doctor-stop-apply", { id: plan.id });
        stopState.textContent = `Stopped ${result.stopped} processes; ${result.skipped} skipped or no longer running. Refresh Doctor after the next memory sample.`;
      } catch (error) {
        stopState.textContent = error.message;
      }
    },
    "danger",
  );
  stopApply.id = "doctor-stop-apply";
  const stopButtons = node("div", null, "buttons");
  stopButtons.append(
    button("Cancel", () => confirm.close()),
    stopApply,
  );
  const stopBody = node("div", null, "doctor-body");
  stopBody.append(stopTitle, stopText, stopButtons, stopState);
  confirm.append(stopBody);
  document.body.append(confirm);
  let busy = false;
  async function stopPreview(provider) {
    try {
      plan = await action("doctor-stop-plan", { provider });
      stopTitle.textContent = `Stop ${provider === "codex" ? "Codex" : "Claude"}?`;
      stopText.textContent = `This ends ${plan.count} verified processes across this app and its tools. ${plan.running} sessions are currently reported running. Unsaved output and running commands can be lost. All accounts in this app may be affected. ${plan.skipped ? `${plan.skipped} inaccessible processes cannot be stopped.` : ""}`;
      stopState.textContent = "";
      stopApply.disabled = false;
      confirm.showModal();
    } catch (error) {
      status.textContent = error.message;
    }
  }
  function renderApps(resources) {
    const fresh =
      resources?.status === "ready" &&
      Date.now() >= resources.sampledAt &&
      Date.now() - resources.sampledAt < 35000;
    appRows.replaceChildren(
      ...(resources?.groups || [])
        .slice()
        .sort((a, b) => (b.memoryBytes || 0) - (a.memoryBytes || 0))
        .map((group) => {
          const row = node("div", null, "doctor-app");
          const text = node("div"),
            label =
              group.provider === "codex"
                ? "Codex"
                : group.provider === "claude"
                  ? "Claude"
                  : "Ocelin";
          text.append(
            node(
              "strong",
              `${label} · ${fresh ? memory(group.memoryBytes) : "Unavailable"}`,
            ),
            node(
              "span",
              `${group.processCount} processes${fresh && group.cpuPercent != null ? ` · ${group.cpuPercent.toFixed(1)}% CPU` : ""}`,
              "muted",
            ),
          );
          row.append(providerIcon(group.provider), text);
          if (group.provider !== "ocelin") {
            const stop = button(`Stop ${label}…`, () =>
              stopPreview(group.provider),
            );
            stop.disabled = !fresh || !group.processCount;
            row.append(stop);
          }
          return row;
        }),
    );
  }
  async function run(operation) {
    if (busy) return;
    busy = true;
    tidy.disabled = undo.disabled = refresh.disabled = age.disabled = true;
    status.textContent = operation === "report" ? "Scanning…" : "Working…";
    renderApps(getState()?.resources);
    try {
      const report = await action(`doctor-${operation}`, {
        olderDays: Number(age.value),
      });
      summary.textContent = `${report.candidates.toLocaleString()} old inactive sessions of ${report.indexed.toLocaleString()} indexed. ${report.missingWorkspaces.toLocaleString()} have missing project folders. ${operation === "tidy" ? "Removed" : "Removable"} workspace caches: ${diskSize(report.caches.bytes)}.`;
      tidy.disabled =
        report.candidates === 0 &&
        (operation === "tidy" || report.caches.count === 0);
      undo.disabled = !report.canUndo;
      status.textContent =
        operation === "tidy"
          ? `Hidden ${report.changed} sessions; skipped ${report.skipped} changed sessions. Removed ${report.caches.count} old Ocelin workspace caches. Original conversations are intact.`
          : operation === "undo"
            ? `Restored ${report.changed} sessions to Ocelin’s history.`
            : `Scan complete.${report.diagnostics?.some((d) => d.capped || d.status) ? " Some sources are incomplete or unavailable; only indexed sessions are included." : ""}`;
      renderApps(report.resources);
      onChange();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      refresh.disabled = age.disabled = false;
    }
  }
  age.addEventListener("change", () => run("report"));
  document.getElementById("doctor").addEventListener("click", () => {
    dialog.showModal();
    void run("report");
  });
  let resourceStamp;
  return (state) => {
    if (
      !dialog.open ||
      confirm.open ||
      appRows.contains(document.activeElement)
    )
      return;
    const next = `${state.resources?.status}:${state.resources?.sampledAt}`;
    if (next !== resourceStamp) {
      resourceStamp = next;
      renderApps(state.resources);
    }
  };
}
