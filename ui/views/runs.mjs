// @ts-check
import {
  el,
  card,
  pill,
  statusTone,
  relTime,
  emptyState,
} from "../lib/dom.mjs";

const FILTERS = [
  ["all", "All"],
  ["running", "Running"],
  ["waiting", "Waiting"],
  ["blocked", "Blocked"],
  ["done", "Completed"],
];
const WORKFLOWS = [
  "implement",
  "investigate",
  "plan-workflow",
  "verify-findings",
  "review-changes",
  "worktree-task",
];
const PERMISSIONS = ["default", "plan", "acceptEdits", "bypassPermissions"];
const PROFILES = ["quick (/wt-verify)", "full (/check)", "none"];

export function render(app) {
  const runs = app.snapshot?.runs ?? [];
  const filter = app.store.runsFilter || "all";
  const filtered = runs.filter((r) => matches(r, filter));

  const chips = el(
    "div",
    { class: "chips" },
    FILTERS.map(([key, label]) =>
      el("button", {
        class: `chip ${filter === key ? "active" : ""}`,
        text: label,
        onClick: () => {
          app.store.runsFilter = key;
          app.rerender();
        },
      }),
    ),
  );

  const list = filtered.length
    ? el("table", { class: "data-table" }, [
        el(
          "thead",
          {},
          el("tr", {}, [
            th("Run"),
            th("Branch"),
            th("Phase"),
            th("Progress"),
            th("Elapsed"),
            th("Updated"),
            th("Status"),
            th(""),
          ]),
        ),
        el(
          "tbody",
          {},
          filtered.map((r) => runRow(r, app)),
        ),
      ])
    : emptyState(
        "No runs match this filter.",
        filter === "all"
          ? "Use the launcher below to start a tracked autoloop run."
          : "Try a different filter.",
      );

  return el("div", { class: "view view-runs" }, [
    card("Runs", [chips, list]),
    launcher(app),
  ]);
}

function matches(r, f) {
  if (f === "all") return true;
  if (f === "done")
    return (
      r.status === "passed" || r.status === "stopped" || r.status === "failed"
    );
  if (f === "blocked") return r.status === "blocked" || r.status === "failed";
  return r.status === f;
}

function th(t) {
  return el("th", { text: t });
}

export function fmtElapsed(startIso, endActive) {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return "·";
  let s = Math.max(
    0,
    Math.floor(((endActive ? Date.now() : start) - start) / 1000),
  );
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

function runRow(r, app) {
  const pct = r.progress != null ? Math.round(r.progress * 100) : 0;
  const canCancel = r.status === "running" || r.status === "waiting";
  const live = r.status === "running" || r.status === "waiting";
  const selected = app.store.selectedRunId === r.id;
  const elapsedCell = el("td", {
    class: "small mono",
    text: fmtElapsed(r.startedAt, live),
  });
  if (live)
    app.store.tickers.push(
      () => (elapsedCell.textContent = fmtElapsed(r.startedAt, true)),
    );

  return el(
    "tr",
    {
      class: `data-row ${selected ? "selected" : ""}`,
      onClick: () => {
        app.store.selectedRunId = r.id;
        app.navigate(`#/runs/${r.id}`);
      },
    },
    [
      el("td", {}, [
        el("strong", { text: r.title }),
        el("div", { class: "muted small mono", text: r.id }),
      ]),
      el("td", { class: "mono small", text: r.branch || "·" }),
      el("td", { text: r.phase }),
      el(
        "td",
        {},
        el(
          "div",
          { class: "progress mini" },
          el("div", { class: "progress-bar", style: `width:${pct}%` }),
        ),
      ),
      elapsedCell,
      el("td", { class: "small", text: relTime(r.updatedAt) }),
      el(
        "td",
        {},
        pill(
          r.stale ? "stale" : r.status,
          r.stale ? "warn" : statusTone(r.status),
        ),
      ),
      el("td", { class: "row-actions" }, [
        el("button", {
          class: "link-btn",
          "data-tip": "Copy run id",
          text: "Copy",
          onClick: (e) => copyId(e, r, app),
        }),
        canCancel
          ? el("button", {
              class: "link-btn danger",
              text: "Cancel",
              onClick: (e) => cancel(e, r, app),
            })
          : null,
      ]),
    ],
  );
}

function copyId(e, r, app) {
  e.stopPropagation();
  navigator.clipboard?.writeText(r.id).then(
    () => app.toast("Run id copied.", "ok"),
    () => app.toast("Clipboard unavailable.", "warn"),
  );
}

async function cancel(e, r, app) {
  e.stopPropagation();
  if (!confirm(`Cancel run "${r.title}"?`)) return;
  try {
    await app.api.action("run.cancel", { runId: r.id });
    app.toast("Run cancelled.", "ok");
  } catch (err) {
    app.toast(`Cancel failed: ${err.message}`, "danger");
  }
}

function launcher(app) {
  const c = app.snapshot?.checkout ?? {};
  const f = {
    task: el("textarea", {
      class: "input",
      name: "task",
      rows: "2",
      placeholder: "Describe the task…",
    }),
    workflow: select(WORKFLOWS, "implement", "workflow"),
    project: el("input", {
      class: "input",
      name: "project",
      value: "client",
      placeholder: "client / server / …",
    }),
    base: el("input", {
      class: "input",
      name: "base",
      value: c.branch || "develop",
    }),
    worktree: select(["current", "new worktree"], "current", "worktree"),
    permission: select(PERMISSIONS, "default", "permission"),
    profile: select(PROFILES, "quick (/wt-verify)", "profile"),
    issue: el("input", {
      class: "input",
      name: "issue",
      placeholder: "PROJ-1234 or MR !123 (optional)",
    }),
    max: el("input", {
      class: "input",
      name: "max",
      type: "number",
      value: "8",
      min: "1",
      max: "50",
    }),
  };
  const preview = el("pre", { class: "command-preview", text: "" });
  const update = () => (preview.textContent = buildPreview(f));
  for (const node of Object.values(f)) node.addEventListener("input", update);
  update();

  const field = (label, node, tip) =>
    el("label", { class: "field" }, [
      el("span", {
        class: tip ? "field-label has-tip" : "field-label",
        text: label,
        "data-tip": tip || null,
      }),
      node,
    ]);

  return card("Task launcher", [
    el("div", { class: "form-grid" }, [
      field(
        "Task description",
        f.task,
        "What you want done, in plain language. Becomes the workflow argument.",
      ),
      field(
        "Workflow",
        f.workflow,
        "implement = build end-to-end · investigate = read-only debugging · plan-workflow = write/critique a plan · verify-findings = check & fix reported issues · review-changes = pre-MR review · worktree-task = run isolated in a worktree.",
      ),
      field(
        "Project",
        f.project,
        "Sub-project the work targets (client, server, management-client …). Sets the run scope.",
      ),
      field(
        "Base branch",
        f.base,
        "Branch the work is based on. Defaults to the current branch.",
      ),
      field(
        "Worktree",
        f.worktree,
        "current = run in this checkout · new worktree = isolate the work in a fresh git worktree (/wt-create).",
      ),
      field(
        "Permission mode",
        f.permission,
        "Claude Code permission mode. default = ask per action · plan = plan only · acceptEdits = auto-accept edits · bypassPermissions = no prompts (use with care).",
      ),
      field(
        "Validation profile",
        f.profile,
        "Checks to run for the work. quick = /wt-verify (tsc/eslint/prettier/jest on the change set) · full = /check · none = skip.",
      ),
      field(
        "Issue / MR",
        f.issue,
        "Optional ticket or MR reference, appended to the task for context (e.g. PROJ-1234).",
      ),
      field(
        "Max iterations (tracked run)",
        f.max,
        "Iteration cap for the tracked autoloop run (1 to 50). The loop also stops on no-progress or a time backstop.",
      ),
    ]),
    el("div", { class: "field" }, [
      el("span", { class: "field-label", text: "Command preview" }),
      preview,
    ]),
    el("div", { class: "btn-row" }, [
      el("button", {
        class: "btn",
        text: "Copy command",
        onClick: () => copy(preview.textContent, app),
      }),
      el("button", {
        class: "btn btn-primary",
        text: "Create tracked run",
        onClick: () => createRun(f, app),
      }),
    ]),
    el("p", {
      class: "muted small",
      text: "Create tracked run records an autoloop run via loop-state (a real, safe local operation). The panel never executes arbitrary workflows itself, paste the command preview into Claude Code to run it.",
    }),
    el("p", {
      class: "muted small",
      text: "Where outputs go: the run's phase, iteration count and per-iteration timeline appear in the Runs table above, click a row for details and evidence. Panel and job events stream in Logs. The agent's own console output stays in the Claude Code session where you ran the command.",
    }),
  ]);
}

function select(options, value, name) {
  return el(
    "select",
    { class: "input", name },
    options.map((o) =>
      el("option", { value: o, selected: o === value ? true : null, text: o }),
    ),
  );
}

function buildPreview(f) {
  const task = (f.task.value || "<task>").replace(/\s+/g, " ").trim();
  const wf = f.workflow.value;
  const issue = f.issue.value.trim();
  const lines = [];
  lines.push(`/${wf} ${task}${issue ? ` (${issue})` : ""}`);
  lines.push("");
  lines.push("# tracked autoloop run (optional, created by this panel):");
  lines.push(
    `node .claude/scripts/loop-state.mjs create --task=${JSON.stringify(task)} --max=${f.max.value || 8}`,
  );
  return lines.join("\n");
}

async function copy(text, app) {
  try {
    await navigator.clipboard.writeText(text);
    app.toast("Command copied.", "ok");
  } catch {
    app.toast("Clipboard unavailable, select and copy manually.", "warn");
  }
}

async function createRun(f, app) {
  const task = (f.task.value || "").trim();
  if (!task) return app.toast("Enter a task description first.", "warn");
  try {
    const res = await app.api.action("autoloop.create", {
      task,
      maxIterations: Number(f.max.value) || 8,
      scope: f.project.value,
    });
    app.toast(`Tracked run created: ${res.run?.runId ?? "ok"}`, "ok");
    app.navigate("#/runs");
  } catch (err) {
    app.toast(`Could not create run: ${err.message}`, "danger");
  }
}
