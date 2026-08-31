// @ts-check
import { el, card, pill, relTime, emptyState } from "../lib/dom.mjs";

const GROUP_ORDER = ["Review", "Validation", "Tests", "Quality", "Git"];
const JOB_TONE = {
  running: "info",
  succeeded: "ok",
  failed: "danger",
  cancelled: "warn",
};

/** Commands, run allowlisted repo commands per worktree with live progress + artifact downloads. */
export function render(app) {
  const store = app.store;
  if (!store.commandList) {
    app.api
      .commands()
      .then((c) => {
        store.commandList = c;
        app.rerender();
      })
      .catch(() => {
        store.commandList = { commands: [], claude: [], error: true };
        app.rerender();
      });
  }
  const data = store.commandList || { commands: [], claude: [] };

  // Worktree target selector.
  const worktrees = app.snapshot?.worktrees ?? [];
  const target = store.commandTarget || "";
  const targetSelect = el(
    "select",
    {
      class: "input",
      name: "command-target",
      "aria-label": "Run in",
      onChange: (e) => {
        store.commandTarget = e.target.value;
      },
    },
    [
      el("option", {
        value: "",
        selected: target === "" ? true : null,
        text: "Current checkout",
      }),
      ...worktrees.map((w) =>
        el("option", {
          value: w.path,
          selected: w.path === target ? true : null,
          text: `${w.branch}${w.isCurrent ? " (this)" : ""}`,
        }),
      ),
    ],
  );

  // Command catalog grouped.
  const byGroup = {};
  for (const c of data.commands) (byGroup[c.group] ||= []).push(c);
  const groups = [
    ...GROUP_ORDER.filter((g) => byGroup[g]),
    ...Object.keys(byGroup).filter((g) => !GROUP_ORDER.includes(g)),
  ];
  const catalog = groups.map((g) =>
    el("div", { class: "cmd-group" }, [
      el("h3", { class: "cmd-group-title", text: g }),
      el(
        "div",
        { class: "cmd-cards" },
        byGroup[g].map((c) => commandCard(c, app)),
      ),
    ]),
  );

  const claude = data.claude?.length
    ? card(
        "Claude commands",
        [
          el("p", {
            class: "muted small",
            text: "The panel cannot run the Claude agent, copy these into Claude Code.",
          }),
          el(
            "div",
            { class: "claude-cmds" },
            data.claude.map((c) =>
              el("div", { class: "claude-cmd" }, [
                el("code", { class: "mono", text: c.cmd }),
                el("span", { class: "muted small", text: c.hint }),
                el("button", {
                  class: "link-btn",
                  text: "Copy",
                  onClick: () => copy(c.cmd, app),
                }),
              ]),
            ),
          ),
        ],
        {},
      )
    : null;

  const catalogCard = card("Run a command", [
    el("div", { class: "toolbar" }, [
      el("label", { class: "inline-field" }, [
        el("span", { text: "Run in" }),
        targetSelect,
      ]),
      el("span", {
        class: "muted small",
        text: "Allowlisted, read-only unless marked.",
      }),
    ]),
    ...catalog,
  ]);

  // Live jobs panel.
  const jobsListEl = el("div", { class: "job-list" });
  const logPanelEl = el("div", { class: "job-log-panel" });
  function paintJobs() {
    const list = store.jobs || [];
    jobsListEl.replaceChildren(
      ...(list.length
        ? list.map((j) => jobRow(j, app, () => openJob(j.id)))
        : [
            emptyState(
              "No jobs yet.",
              "Run a command to see live progress here.",
            ),
          ]),
    );
  }
  async function openJob(id) {
    store.openJobId = id;
    paintLog();
    try {
      const detail = await app.api.job(id);
      store.jobLogs[id] = detail.lines || [];
      paintLog();
    } catch {
      /* job gone */
    }
  }
  function paintLog() {
    const id = store.openJobId;
    const job = (store.jobs || []).find((j) => j.id === id);
    if (!id || !job) {
      logPanelEl.replaceChildren(emptyState("Select a job to view its log."));
      return;
    }
    const body = el("div", { class: "job-log-body mono" });
    for (const l of store.jobLogs[id] || []) body.append(logLine(l));
    const header = el("div", { class: "job-log-head" }, [
      el("div", {}, [
        el("strong", { text: job.label }),
        el("div", {
          class: "muted small",
          text: `${job.worktree || "current checkout"} · ${job.status}`,
        }),
      ]),
      el("div", { class: "btn-row" }, [
        job.status === "running"
          ? el("button", {
              class: "btn btn-danger btn-sm",
              text: "Cancel",
              onClick: () => app.api.cancelJob(id),
            })
          : null,
        job.artifact?.ready
          ? el("a", {
              class: "btn btn-primary btn-sm",
              href: app.api.artifactUrl(id),
              text: `Download ${job.artifact.name}`,
            })
          : null,
      ]),
    ]);
    const children = [header];
    if (job.status === "running")
      children.push(el("div", { class: "job-bar indeterminate" }, el("span")));
    children.push(body);
    logPanelEl.replaceChildren(...children);
    body.scrollTop = body.scrollHeight;
  }

  const asideEl = el("div", { class: "jobs-aside" });
  function paintAside() {
    const running = (store.jobs || []).filter((j) => j.status === "running");
    asideEl.replaceChildren(
      pill(`${running.length} running`, "info"),
      running.length
        ? el("button", {
            class: "link-btn danger",
            text: "Cancel all",
            "data-tip": "Cancel every running job",
            onClick: () => cancelAll(app),
          })
        : null,
    );
  }

  // Live hooks (replaced each render; the latest mounted view owns them).
  store._onJobChange = () => {
    paintJobs();
    paintAside();
    paintLog();
  };
  store._onJobLog = (jobId, line) => {
    if (jobId !== store.openJobId) return;
    const body = logPanelEl.querySelector(".job-log-body");
    if (body) {
      body.append(logLine(line));
      body.scrollTop = body.scrollHeight;
    }
  };

  paintJobs();
  paintAside();
  paintLog();
  // Tick live elapsed timers on running jobs once a second (cleared on navigate).
  store.tickers.push(() => {
    for (const node of [jobsListEl, logPanelEl]) {
      for (const span of node.querySelectorAll(".job-elapsed[data-start]")) {
        span.textContent = `running ${elapsed(span.getAttribute("data-start"))}`;
      }
    }
  });
  const jobsCard = card("Jobs", [jobsListEl, logPanelEl], { aside: asideEl });

  return el("div", { class: "view view-commands" }, [
    el("div", { class: "grid grid-cmd" }, [
      el("div", { class: "stack-col" }, [catalogCard, claude]),
      jobsCard,
    ]),
  ]);
}

function commandCard(c, app) {
  const actions = [
    el("button", {
      class: "btn btn-sm",
      text: "Run",
      onClick: () => run(c, app),
    }),
  ];
  let previewHost = null;
  if (c.key === "review-pack") {
    previewHost = el("div", { class: "diff-preview" });
    actions.push(
      el("button", {
        class: "btn btn-sm btn-ghost",
        "data-tip": "Show the files and +/- lines this pack would contain",
        text: "Preview diff",
        onClick: () => loadDiffPreview(app, previewHost),
      }),
    );
  }
  return el("div", { class: "cmd-card" }, [
    el("div", { class: "cmd-card-head" }, [
      el("strong", { text: c.label }),
      c.mutating ? pill("writes files", "warn") : null,
      c.network ? pill("network", "neutral") : null,
    ]),
    el("p", { class: "muted small", text: c.description }),
    el("div", { class: "btn-row" }, actions),
    previewHost,
  ]);
}

async function loadDiffPreview(app, host) {
  host.replaceChildren(
    el("span", { class: "muted small", text: "Loading diff…" }),
  );
  try {
    const p = await app.api.reviewPackPreview(app.store.commandTarget || "");
    renderDiffPreview(host, p);
  } catch (err) {
    host.replaceChildren(
      el("span", {
        class: "muted small",
        text: `Could not load diff: ${err.message}`,
      }),
    );
  }
}

function renderDiffPreview(host, p) {
  if (!p || !p.totalFiles) {
    host.replaceChildren(
      el("p", {
        class: "muted small",
        text: `No changes vs ${p?.base || "base"} (the pack would be empty).`,
      }),
    );
    return;
  }
  const rows = p.files.slice(0, 50).map((f) =>
    el("div", { class: "diff-row" }, [
      el("span", { class: "diff-path mono small", text: f.path }),
      el("span", {
        class: "diff-add mono small",
        text: f.added == null ? "bin" : `+${f.added}`,
      }),
      el("span", {
        class: "diff-del mono small",
        text: f.removed == null ? "" : `-${f.removed}`,
      }),
    ]),
  );
  host.replaceChildren(
    el("div", {
      class: "diff-summary small",
      text: `${p.totalFiles} files, +${p.totalAdded} / -${p.totalRemoved} vs ${p.base} (${p.baseSha})`,
    }),
    el("div", { class: "diff-rows" }, rows),
    p.totalFiles > 50
      ? el("p", {
          class: "muted small",
          text: `+${p.totalFiles - 50} more files.`,
        })
      : null,
  );
}

async function run(c, app) {
  if (
    c.mutating &&
    !confirm(`${c.label} writes to the working tree. Continue?`)
  )
    return;
  const params = { key: c.key };
  if (c.scope !== "checkout" && app.store.commandTarget)
    params.worktreePath = app.store.commandTarget;
  try {
    const res = await app.api.runJob(params);
    if (res.ok === false)
      return app.toast(res.error || "Could not start job.", "danger");
    app.store.openJobId = res.jobId;
    app.store.jobLogs[res.jobId] = [];
    app.toast(`${c.label} started.`, "info");
    app.rerender();
  } catch (err) {
    app.toast(`Could not start: ${err.message}`, "danger");
  }
}

function jobRow(j, app, onOpen) {
  const live = j.status === "running";
  const open = app.store.openJobId === j.id;
  return el(
    "div",
    {
      class: `job-row ${open ? "selected" : ""}`,
      onClick: onOpen,
      tabindex: "0",
      role: "button",
      onKeydown: (e) => e.key === "Enter" && onOpen(),
    },
    [
      el("div", { class: "job-main" }, [
        el("strong", { text: j.label }),
        live
          ? el("div", { class: "muted small" }, [
              el("span", { text: `${j.worktree || "current"} · ` }),
              el("span", {
                class: "job-elapsed mono small",
                "data-start": j.startedAt,
                text: `running ${elapsed(j.startedAt)}`,
              }),
            ])
          : el("div", {
              class: "muted small",
              text: `${j.worktree || "current"} · ${relTime(j.startedAt)}`,
            }),
      ]),
      j.artifact?.ready
        ? el("span", { class: "job-artifact", text: "⬇ zip" })
        : null,
      live
        ? el("span", { class: "spinner" })
        : pill(j.status, JOB_TONE[j.status] || "neutral"),
    ],
  );
}

/** "1m 05s" style elapsed since an ISO start, for a running job. */
function elapsed(startISO) {
  const start = Date.parse(startISO);
  if (!Number.isFinite(start)) return "0s";
  const sec = Math.max(0, Math.round((Date.now() - start) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

async function cancelAll(app) {
  const running = (app.store.jobs || []).filter((j) => j.status === "running");
  if (!running.length) return;
  app.toast(`Cancelling ${running.length} job(s)…`, "info");
  await Promise.all(
    running.map((j) => app.api.cancelJob(j.id).catch(() => {})),
  );
}

function logLine(l) {
  return el(
    "div",
    { class: `log-line lvl-${l.level === "error" ? "error" : "info"}` },
    el("span", { class: "log-msg", text: l.line }),
  );
}

function copy(text, app) {
  navigator.clipboard?.writeText(text).then(
    () => app.toast("Copied.", "ok"),
    () => app.toast("Clipboard unavailable.", "warn"),
  );
}
