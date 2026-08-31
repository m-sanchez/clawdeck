// @ts-check
/** Ctrl/Cmd+K command palette: fuzzy-jump to views, runs, worktrees + actions. */
import { el, clear } from "./dom.mjs";

let openEl = null;

/** Build the command list from the current app state. */
function buildCommands(app) {
  const s = app.snapshot;
  const go = (id, label, hash) => ({
    id: `go-${id}`,
    label: `Go: ${label}`,
    hint: "view",
    run: () => app.navigate(hash),
  });
  /** @type {{ id: string, label: string, hint?: string, run: () => void }[]} */
  const cmds = [
    go("overview", "Overview", "#/overview"),
    go("timeline", "Timeline", "#/activity/timeline"),
    go("logs", "Logs", "#/activity/logs"),
    go("runs", "Runs", "#/run/runs"),
    go("commands", "Commands", "#/run/commands"),
    go("worktrees", "Worktrees", "#/worktrees"),
    go("diff", "Diff", "#/review/diff"),
    go("validation", "Validation", "#/review/validation"),
    go("reviews", "Reviews", "#/review/reviews"),
    go("mr", "Merge Request", "#/review/mr"),
    go("finder", "Data Finder", "#/data/finder"),
    go("console", "Console", "#/data/console"),
    go("inspector", "Inspector", "#/data/inspector"),
    go("prompt", "Prompt", "#/prompt"),
    go("config", "Configuration", "#/config"),
    {
      id: "act-refresh",
      label: "Refresh now",
      hint: "action",
      run: () => app.refreshNow(),
    },
    {
      id: "act-theme",
      label: "Toggle theme",
      hint: "action",
      run: () => app.cycleTheme(),
    },
    {
      id: "act-validate",
      label: "Run validation",
      hint: "action",
      run: () =>
        app.api
          .action("validation.run", {})
          .then(() => app.toast("Validation started.", "info")),
    },
    {
      id: "act-review",
      label: "Re-run review scan",
      hint: "action",
      run: () =>
        app.api
          .action("review.run", {})
          .then(() => app.toast("Review scan complete.", "ok")),
    },
    {
      id: "act-export",
      label: "Export snapshot (JSON)",
      hint: "action",
      run: () => app.exportSnapshot(),
    },
    {
      id: "act-status-copy",
      label: "Copy status report (Markdown)",
      hint: "action",
      run: () => app.copyStatusReport(),
    },
    {
      id: "act-status-download",
      label: "Download status report (.md)",
      hint: "action",
      run: () => app.downloadStatusReport(),
    },
    {
      id: "act-shortcuts",
      label: "Keyboard shortcuts",
      hint: "?",
      run: () => app.openShortcuts(),
    },
    {
      id: "open-gallery",
      label: "Open Clawd gallery",
      hint: "open ↗",
      run: () => window.open("/clawd-gallery.html", "_blank"),
    },
    {
      id: "open-playground",
      label: "Open Clawd reference",
      hint: "open ↗",
      run: () => window.open("/clawd-playground", "_blank"),
    },
  ];
  for (const r of s?.runs ?? [])
    cmds.push({
      id: `run-${r.id}`,
      label: `Run: ${r.title}`,
      hint: r.status,
      run: () => app.navigate(`#/run/runs/${r.id}`),
    });
  for (const w of s?.worktrees ?? []) {
    const url = (w.services ?? []).find(
      (x) => x.url && x.status === "running",
    )?.url;
    if (url)
      cmds.push({
        id: `wt-${w.id}`,
        label: `Open worktree: ${w.branch}`,
        hint: "open ↗",
        run: () => window.open(url, "_blank"),
      });
    cmds.push({
      id: `wtjump-${w.id}`,
      label: `Worktree: ${w.branch || "(detached)"}`,
      hint: "worktree",
      run: () => {
        app.store.worktreeQuery =
          (w.branch || w.path || "").replace(/\\/g, "/").split("/").pop() || "";
        app.navigate("#/worktrees");
      },
    });
  }
  for (const f of s?.findings ?? [])
    cmds.push({
      id: `finding-${f.ruleId || "x"}-${f.file || ""}-${f.line || ""}`,
      label: `Finding: ${f.ruleId ? `${f.ruleId} ` : ""}${f.file || "(no file)"}${f.line ? `:${f.line}` : ""}`,
      hint: f.severity || "finding",
      run: () => {
        app.store.reviewSeverity = f.severity || "all";
        app.navigate("#/review/reviews");
      },
    });
  for (const c of app.store?.commandCatalog ?? [])
    cmds.push({
      id: `cmd-${c.key}`,
      label: `Command: ${c.label}`,
      hint: c.group ? String(c.group).toLowerCase() : "command",
      run: () => app.navigate("#/commands"),
    });
  return cmds;
}

function score(label, q) {
  const l = label.toLowerCase();
  if (!q) return 1;
  if (l.includes(q)) return 100 - l.indexOf(q);
  // subsequence fuzzy match
  let qi = 0;
  for (let i = 0; i < l.length && qi < q.length; i++) if (l[i] === q[qi]) qi++;
  return qi === q.length ? 1 : 0;
}

export function openPalette(app) {
  if (openEl) return;
  const commands = buildCommands(app);
  let active = 0;
  let filtered = commands;

  const input = /** @type {HTMLInputElement} */ (
    el("input", {
      class: "cmd-input",
      type: "text",
      name: "command",
      placeholder: "Type a command or destination…",
      "aria-label": "Command palette",
    })
  );
  const list = el("ul", { class: "cmd-list", role: "listbox" });
  const overlay = el(
    "div",
    { class: "cmd-overlay", role: "dialog", "aria-modal": "true" },
    el("div", { class: "cmd-box" }, [input, list]),
  );

  function paint() {
    const q = input.value.trim().toLowerCase();
    filtered = commands
      .map((c) => ({ c, s: score(c.label, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c)
      .slice(0, 40);
    if (active >= filtered.length) active = Math.max(0, filtered.length - 1);
    clear(list).append(
      ...filtered.map((c, i) =>
        el(
          "li",
          {
            class: `cmd-item ${i === active ? "active" : ""}`,
            role: "option",
            onMousedown: (e) => {
              e.preventDefault();
              choose(c);
            },
          },
          [
            el("span", { class: "cmd-label", text: c.label }),
            c.hint ? el("span", { class: "cmd-hint", text: c.hint }) : null,
          ],
        ),
      ),
    );
  }

  function choose(c) {
    close();
    c.run();
  }

  function close() {
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
    openEl = null;
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(filtered.length - 1, active + 1);
      paint();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(0, active - 1);
      paint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[active]) choose(filtered[active]);
    }
  }

  input.addEventListener("input", paint);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener("keydown", onKey, true);

  document.body.append(overlay);
  openEl = overlay;
  paint();
  input.focus();
}
