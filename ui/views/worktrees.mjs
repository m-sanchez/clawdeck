// @ts-check
import {
  el,
  card,
  pill,
  statusTone,
  relTime,
  emptyState,
  actionMenu,
} from "../lib/dom.mjs";

/** Worktrees, branch/path, owned services + ports, process health, data mode. */
export function render(app) {
  const all = app.snapshot?.worktrees ?? [];
  if (!all.length)
    return el(
      "div",
      { class: "view" },
      card(
        "Worktrees",
        emptyState(
          "No worktrees found.",
          "git worktree list returned nothing.",
        ),
      ),
    );

  const q = (app.store.worktreeQuery || "").toLowerCase();
  const match = (w) => !q || `${w.branch} ${w.path}`.toLowerCase().includes(q);
  const visible = all.filter(match);
  const registered = visible.filter((w) => w.registered || w.isCurrent);
  const unregistered = visible.filter((w) => !w.registered && !w.isCurrent);
  const showUnreg = app.store.showUnregistered || Boolean(q);

  const search = el("input", {
    class: "input search",
    type: "search",
    name: "worktree-filter",
    "aria-label": "Filter worktrees",
    placeholder: "Filter by branch or path…",
    value: app.store.worktreeQuery || "",
    oninput: (e) => {
      app.store.worktreeQuery = e.target.value;
      app.rerender();
      const node = /** @type {HTMLInputElement|null} */ (
        document.querySelector(".view-worktrees .search")
      );
      if (node) {
        node.focus();
        node.setSelectionRange(node.value.length, node.value.length);
      }
    },
  });

  const head = card("Worktrees", [
    el("p", {
      class: "muted small",
      text: "Ports and slots come from the central .claude/.wt-registry; service state is probed live. Unregistered worktrees were created outside the /wt-create lifecycle.",
    }),
    el("div", { class: "toolbar" }, [
      search,
      el("span", {
        class: "muted small",
        text: `${all.length} total · ${registered.length} active/registered · ${all.length - registered.length} other`,
      }),
    ]),
  ]);

  const compact = Boolean(app.config?.compactWorktrees);
  const renderSet = (set) =>
    compact
      ? compactTable(set, app)
      : el(
          "div",
          { class: "wt-list" },
          set.map((w) => worktreeCard(w, app)),
        );

  // Summary widgets tile horizontally on wide screens instead of stacking.
  const summary = [
    cleanupAdvisorCard(all, app),
    remoteBranchesCard(app),
    slotMapCard(all),
  ].filter(Boolean);
  const blocks = [head, el("div", { class: "tile-row" }, summary)];
  blocks.push(
    registered.length
      ? renderSet(registered)
      : el("p", {
          class: "muted small",
          text: "No registered or current worktrees match.",
        }),
  );

  if (unregistered.length) {
    const toggle = el("button", {
      class: "chip",
      text: showUnreg
        ? `Hide ${unregistered.length} unregistered ▲`
        : `Show ${unregistered.length} unregistered ▼`,
      onClick: () => {
        app.store.showUnregistered = !showUnreg;
        app.rerender();
      },
    });
    blocks.push(el("div", { class: "wt-unreg-toggle" }, toggle));
    if (showUnreg) blocks.push(renderSet(unregistered));
  }

  return el("div", { class: "view view-worktrees" }, blocks);
}

/**
 * Always-visible cleanup advisor: every worktree whose branch is already merged
 * into develop. Idle ones are safe to remove; busy/current ones are flagged but
 * not actionable yet. Independent of compact/card mode so the answer to "why is
 * this still here?" is never buried in a collapsed group.
 */
function cleanupAdvisorCard(all, app) {
  const candidates = all.filter((w) => w.cleanupCandidate);
  const busyMerged = all.filter(
    (w) => w.merged && !w.cleanupCandidate && !w.isCurrent,
  );
  const dormant = dormantWorktrees(all, app);
  if (!candidates.length && !busyMerged.length && !dormant.length) return null;
  const rows = candidates.map((w) =>
    el("div", { class: "cleanup-row" }, [
      el("span", { class: "wt-cleanup-icon ok-text", text: "✓" }),
      el("strong", { class: "mono small", text: w.branch }),
      el("span", { class: "muted small", text: "merged into develop, idle" }),
      el("span", { class: "spacer" }),
      el("button", {
        class: "chip",
        "data-tip": "Copy the safe-removal command to run in your terminal",
        text: "Copy /wt-cleanup",
        onClick: () => copyText("/wt-cleanup --apply", app),
      }),
      el("button", {
        class: "chip ghost",
        "data-tip": "Run the dry-run preview now (removes nothing)",
        text: "Preview",
        onClick: () => runOnWorktree(app, "wt-cleanup-dry", w),
      }),
    ]),
  );
  return card(
    `Cleanup advisor (${candidates.length})`,
    [
      el("p", {
        class: "muted small",
        text: "Branches already merged into develop with nothing running. Safe to remove: copy the command, preview the dry run, or run the apply below (asks for confirmation; the lifecycle script still refuses anything dirty or running).",
      }),
      candidates.length
        ? null
        : el("p", {
            class: "muted small",
            text: "No merged-and-idle worktrees.",
          }),
      ...rows,
      candidates.length
        ? el("div", { class: "wt-cleanup-actions" }, [
            el("button", {
              class: "chip",
              "data-tip":
                "Preview which worktrees would be removed (removes nothing)",
              text: "Preview all",
              onClick: () =>
                runOnWorktree(app, "wt-cleanup-dry", candidates[0]),
            }),
            el("button", {
              class: "chip fix-chip",
              "data-tip":
                "Remove all proven-safe worktrees now (asks to confirm)",
              text: "Run cleanup (apply)",
              onClick: () => applyCleanup(app),
            }),
          ])
        : null,
      busyMerged.length
        ? el("p", {
            class: "muted small",
            text: `${busyMerged.length} more branch(es) merged but still current or busy, stop them first.`,
          })
        : null,
      ...dormantBlock(dormant, app),
    ],
    {
      help: 'A worktree whose branch is already merged into develop (origin/HEAD) with no live process. Answers "why is this still here?", it can be cleaned up.',
    },
  );
}

/**
 * Registered worktrees nobody is using: not merged, not current, no running
 * service, no Claude session, and no recorded activity in the last 7 days. These
 * may still hold unpushed work, so they are surfaced for review, never auto-removed.
 */
function dormantWorktrees(all, app) {
  const sessionPaths = new Set(
    (app.snapshot?.sessions?.agents ?? []).map((a) => a.path),
  );
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  return all.filter((w) => {
    if (!w.registered || w.isCurrent || w.merged || w.detached) return false;
    if ((w.services ?? []).some((s) => s.status === "running")) return false;
    if (sessionPaths.has(w.path)) return false;
    const last = w.lastActivity ? Date.parse(w.lastActivity) : 0;
    return !last || now - last > weekMs;
  });
}

function dormantBlock(dormant, app) {
  if (!dormant.length) return [];
  const shown = dormant.slice(0, 8);
  return [
    el("p", {
      class: "muted small dormant-head",
      text: `${dormant.length} dormant worktree(s): registered, unmerged, no session or activity in 7 days. May hold unpushed work, so review before removing.`,
    }),
    ...shown.map((w) =>
      el("div", { class: "cleanup-row" }, [
        el("span", { class: "wt-cleanup-icon warn-text", text: "●" }),
        el("strong", { class: "mono small", text: w.branch }),
        el("span", {
          class: "muted small",
          text: w.lastActivity
            ? `last active ${relTime(w.lastActivity)}`
            : "never launched",
        }),
        el("span", { class: "spacer" }),
        el("button", {
          class: "chip ghost",
          "data-tip": "Show git status for this worktree before deciding",
          text: "git status",
          onClick: () => runOnWorktree(app, "git-status", w),
        }),
      ]),
    ),
    dormant.length > shown.length
      ? el("p", {
          class: "muted small",
          text: `+${dormant.length - shown.length} more. Run Worktree doctor for the full view.`,
        })
      : null,
  ];
}

/**
 * Remote branches already merged into develop but still on origin. Read-only:
 * the panel surfaces them and the exact delete command, and never deletes.
 */
function remoteBranchesCard(app) {
  const rb = app.snapshot?.remoteBranches;
  if (!rb || !rb.total) return null;
  const shown = rb.branches.slice(0, 12);
  const rows = shown.map((b) =>
    el("div", { class: "cleanup-row" }, [
      el("strong", { class: "mono small", text: b }),
      el("span", { class: "spacer" }),
      actionMenu(
        [
          {
            label: "Copy command",
            onClick: () => copyText(`git push origin --delete ${b}`, app),
          },
          {
            label: "Delete on origin",
            danger: true,
            onClick: () => deleteRemoteBranch(app, b),
          },
        ],
        { label: "Copy delete", class: "ghost" },
      ),
    ]),
  );
  return card(
    `Merged remote branches (${rb.total})`,
    [
      el("p", {
        class: "muted small",
        text: "Already merged into develop but still on origin. Run git fetch --prune first; the panel never deletes.",
      }),
      ...rows,
      rb.total > shown.length
        ? el("p", {
            class: "muted small",
            text: `+${rb.total - shown.length} more.`,
          })
        : null,
      el("div", { class: "wt-cleanup-actions" }, [
        el("button", {
          class: "chip",
          text: "Copy all delete commands",
          onClick: () =>
            copyText(
              rb.branches
                .map((b) => `git push origin --delete ${b}`)
                .join("\n"),
              app,
            ),
        }),
      ]),
    ],
    {
      help: "Remote-tracking branches whose tip is an ancestor of origin/HEAD (develop). Safe to delete on origin once you confirm they are truly merged.",
    },
  );
}

function compactTable(set, app) {
  return el("div", { class: "card worktree-table-wrap" }, [
    el("table", { class: "data-table compact" }, [
      el(
        "thead",
        {},
        el("tr", {}, [
          el("th", { text: "Branch" }),
          el("th", { text: "Slot" }),
          el("th", { text: "Services" }),
          el("th", { text: "Data mode" }),
          el("th", { text: "Activity" }),
          el("th", { text: "" }),
        ]),
      ),
      el(
        "tbody",
        {},
        set.map((w) => {
          const running = (w.services ?? []).filter(
            (s) => s.status === "running",
          );
          return el("tr", { class: w.isCurrent ? "selected" : "" }, [
            el("td", { class: "mono small" }, [
              el("strong", {
                text: w.branch || "(detached)",
                "data-tip": w.lastCommit
                  ? `${w.lastCommit.subject} (${w.lastCommit.author}${w.lastCommit.date ? `, ${relTime(w.lastCommit.date)}` : ""})`
                  : null,
              }),
              w.isCurrent ? pill("this", "info") : null,
              w.cleanupCandidate
                ? pill("cleanup", "ok")
                : w.merged
                  ? pill("merged", "neutral")
                  : null,
              aheadBehind(w),
              branchAgeBadge(w),
            ]),
            el("td", {
              class: "small",
              text: w.slot != null ? `#${w.slot}` : "·",
            }),
            el(
              "td",
              {},
              running.length
                ? el(
                    "div",
                    { class: "service-pills" },
                    running.map((s) =>
                      el("span", { class: "service-pill", text: `:${s.port}` }),
                    ),
                  )
                : el("span", { class: "muted small", text: "·" }),
            ),
            el("td", { class: "small", text: w.dataMode || "·" }),
            el("td", {
              class: "small",
              text: w.lastActivity ? relTime(w.lastActivity) : "·",
            }),
            el("td", { class: "row-actions" }, [
              el("button", {
                class: "link-btn",
                text: "review-pack",
                onClick: () => runOnWorktree(app, "review-pack", w),
              }),
              actionMenu(
                [
                  {
                    label: "Copy command",
                    onClick: () => copyText(`code ${quotePath(w.path)}`, app),
                  },
                  {
                    label: "Open in VS Code",
                    onClick: () => openWorktreeEditor(app, w),
                  },
                ],
                { label: "editor", class: "ghost" },
              ),
              w.branch
                ? el("button", {
                    class: "link-btn",
                    "data-tip": "Copy branch name",
                    text: "branch",
                    onClick: () => copyText(w.branch, app),
                  })
                : null,
              el("button", {
                class: "link-btn",
                text: "copy",
                onClick: () => copyPath(w.path, app),
              }),
            ]),
          ]);
        }),
      ),
    ]),
  ]);
}

function slotMapCard(all) {
  const bySlot = new Map();
  for (const w of all) if (w.slot != null) bySlot.set(Number(w.slot), w);
  const maxUsed = bySlot.size ? Math.max(...bySlot.keys()) : 0;
  const count = Math.min(50, Math.max(20, maxUsed));
  const cells = [];
  for (let i = 1; i <= count; i++) {
    const w = bySlot.get(i);
    const cls = ["slot-cell"];
    if (w) cls.push("used");
    if (w?.isCurrent) cls.push("current");
    if (w && (w.services ?? []).some((s) => s.status === "running"))
      cls.push("running");
    cells.push(
      el(
        "div",
        {
          class: cls.join(" "),
          "data-tip": w ? `slot ${i}: ${w.branch}` : `slot ${i}: free`,
        },
        String(i),
      ),
    );
  }
  return card("Slot map", [
    el("p", {
      class: "muted small",
      text: `${bySlot.size} of ${count} shown slots reserved. Each worktree owns a deterministic port band.`,
    }),
    el("div", { class: "slot-map" }, cells),
  ]);
}

/** A "↑ahead ↓behind develop" badge, or an in-sync pill, when known. */
function aheadBehind(w) {
  if (w.ahead == null && w.behind == null) return null;
  const ahead = w.ahead || 0;
  const behind = w.behind || 0;
  if (!ahead && !behind) return pill("in sync", "ok");
  return el(
    "span",
    {
      class: "ab-badge mono",
      "data-tip": `${ahead} commit(s) ahead of develop, ${behind} behind`,
    },
    [
      el("span", { class: "ab-ahead", text: `↑${ahead}` }),
      el("span", { class: "ab-behind", text: `↓${behind}` }),
    ],
  );
}

const STALE_DAYS = 14;

/** A "stale Nd" badge when the branch's last commit is older than STALE_DAYS. */
function branchAgeBadge(w) {
  const t = w.lastCommit?.date ? Date.parse(w.lastCommit.date) : NaN;
  if (!Number.isFinite(t) || w.isCurrent) return null;
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days < STALE_DAYS) return null;
  return pill(`stale ${days}d`, "warn");
}

function worktreeCard(w, app) {
  const services = w.services ?? [];
  const agent = (app.snapshot?.sessions?.agents ?? []).find(
    (a) => a.path === w.path,
  );
  const aside = el("div", { class: "wt-tags" }, [
    agent?.active ? pill("claude active", "ok") : null,
    w.isCurrent ? pill("this worktree", "info") : null,
    w.registered
      ? pill(`slot ${w.slot}`, "neutral")
      : pill("unregistered", "neutral"),
    w.dataMode
      ? pill(w.dataMode, w.dataMode === "shared-write" ? "warn" : "neutral")
      : null,
    w.detached ? pill("detached", "warn") : null,
    w.locked ? pill("locked", "warn") : null,
    w.cleanupCandidate
      ? pill("cleanup candidate", "ok")
      : w.merged
        ? pill("merged", "neutral")
        : null,
    aheadBehind(w),
    branchAgeBadge(w),
  ]);

  const svcTable = services.length
    ? el("table", { class: "data-table compact" }, [
        el(
          "thead",
          {},
          el("tr", {}, [
            el("th", { text: "Service" }),
            el("th", { text: "Port" }),
            el("th", { text: "Status" }),
            el("th", { text: "" }),
          ]),
        ),
        el(
          "tbody",
          {},
          services.map((s) =>
            el("tr", {}, [
              el("td", { class: "mono small", text: s.id }),
              el("td", { class: "mono small", text: s.port ?? "·" }),
              el(
                "td",
                {},
                pill(
                  s.status,
                  statusTone(s.status === "running" ? "running" : "stopped"),
                ),
              ),
              el(
                "td",
                {},
                s.url && s.status === "running"
                  ? el("a", {
                      class: "link-btn",
                      href: s.url,
                      target: "_blank",
                      rel: "noreferrer",
                      text: "Open ↗",
                    })
                  : null,
              ),
            ]),
          ),
        ),
      ])
    : el("p", {
        class: "muted small",
        text: w.registered
          ? "No services currently listening."
          : "No registered services (run /wt-run to launch the stack).",
      });

  return el("section", { class: `wt-card ${w.isCurrent ? "current" : ""}` }, [
    el("div", { class: "wt-head" }, [
      el("div", { class: "wt-id" }, [
        el("button", {
          class: "wt-branch mono",
          "data-tip": w.branch ? "Copy branch name" : null,
          text: w.branch || "(detached)",
          onClick: () => w.branch && copyText(w.branch, app),
        }),
        el("button", {
          class: "copy-path mono small",
          "data-tip": "Copy path",
          text: w.path,
          onClick: () => copyPath(w.path, app),
        }),
      ]),
      aside,
    ]),
    el("div", { class: "wt-meta muted small" }, [
      `HEAD ${w.head || "?"}`,
      w.processActive ? " · processes active" : "",
      w.lastActivity ? ` · active ${relTime(w.lastActivity)}` : "",
      agent
        ? ` · ${agent.sessionCount} claude session${agent.sessionCount === 1 ? "" : "s"}${agent.lastActivity ? ` (last ${relTime(agent.lastActivity)})` : ""}`
        : "",
    ]),
    w.lastCommit
      ? el("div", { class: "wt-lastcommit" }, [
          el("span", {
            class: "commit-subject small",
            "data-tip": w.lastCommit.subject,
            text: w.lastCommit.subject,
          }),
          el("span", {
            class: "muted small wt-lastcommit-meta",
            text: `${w.lastCommit.author}${w.lastCommit.date ? ` · ${relTime(w.lastCommit.date)}` : ""}`,
          }),
        ])
      : null,
    cleanupAdvisory(w, app),
    svcTable,
    el("div", { class: "wt-run-row" }, [
      el("span", { class: "muted small", text: "Run here:" }),
      el("button", {
        class: "chip",
        text: "Review pack",
        onClick: () => runOnWorktree(app, "review-pack", w),
      }),
      el("button", {
        class: "chip",
        text: "Verify",
        onClick: () => runOnWorktree(app, "wt-verify", w),
      }),
      el("button", {
        class: "chip",
        text: "git status",
        onClick: () => runOnWorktree(app, "git-status", w),
      }),
      actionMenu(
        [
          {
            label: "Copy command",
            onClick: () => copyText(`code ${quotePath(w.path)}`, app),
          },
          {
            label: "Open in VS Code",
            onClick: () => openWorktreeEditor(app, w),
          },
        ],
        { label: "Open in editor", class: "ghost" },
      ),
    ]),
  ]);
}

/** Quote a path for a shell command only when it needs it. */
function quotePath(p) {
  const s = String(p || "");
  return /\s/.test(s) ? `"${s}"` : s;
}

/**
 * Cleanup advice for a worktree whose branch is already merged into develop.
 * Answers "if it's pushed/merged, why is it still here?". The panel never removes
 * a worktree itself; it surfaces the reason and the exact command to run.
 */
function cleanupAdvisory(w, app) {
  if (!w.merged) return null;
  if (w.cleanupCandidate) {
    return el("div", { class: "wt-cleanup ok" }, [
      el("span", { class: "wt-cleanup-icon", text: "✓" }),
      el("div", { class: "wt-cleanup-body" }, [
        el("strong", { text: "Merged into develop, idle." }),
        el("p", {
          class: "muted small",
          text: "Its work is already on develop and nothing is running here. Safe to remove.",
        }),
        el("div", { class: "wt-cleanup-actions" }, [
          el("button", {
            class: "chip",
            text: "Copy /wt-cleanup --apply",
            onClick: () => copyText("/wt-cleanup --apply", app),
          }),
          el("button", {
            class: "chip ghost",
            text: "Preview cleanup",
            onClick: () => runOnWorktree(app, "wt-cleanup-dry", w),
          }),
        ]),
      ]),
    ]);
  }
  return el("div", { class: "wt-cleanup warn" }, [
    el("span", { class: "wt-cleanup-icon", text: "●" }),
    el("div", { class: "wt-cleanup-body" }, [
      el("strong", { text: "Merged, but still busy." }),
      el("p", {
        class: "muted small",
        text:
          w.cleanupReason ||
          "Branch is merged, but this worktree is current or has live processes, stop it before removing.",
      }),
    ]),
  ]);
}

async function runOnWorktree(app, key, w) {
  try {
    const res = await app.api.runJob({ key, worktreePath: w.path });
    if (res.ok === false)
      return app.toast(res.error || "Could not start job.", "danger");
    app.store.openJobId = res.jobId;
    app.store.jobLogs[res.jobId] = [];
    app.toast(`${res.job?.label || key} started on ${w.branch}.`, "info");
    app.navigate("#/commands");
  } catch (err) {
    app.toast(`Could not start: ${err.message}`, "danger");
  }
}

function copyPath(path, app) {
  navigator.clipboard?.writeText(path).then(
    () => app.toast("Path copied.", "ok"),
    () => app.toast("Clipboard unavailable.", "warn"),
  );
}

function copyText(text, app) {
  navigator.clipboard?.writeText(text).then(
    () => app.toast(`Copied: ${text}`, "ok"),
    () => app.toast("Clipboard unavailable.", "warn"),
  );
}

async function openWorktreeEditor(app, w) {
  try {
    const res = await app.api.action("editor.open", { worktreePath: w.path });
    app.toast(
      res.ok ? "Opening in VS Code…" : res.error || "Could not open editor.",
      res.ok ? "ok" : "danger",
    );
  } catch (err) {
    app.toast(`Could not open: ${err.message}`, "danger");
  }
}

async function applyCleanup(app) {
  if (
    !confirm(
      "Remove all merged, idle worktrees now? The lifecycle script still refuses anything dirty, running, or uncertain.",
    )
  )
    return;
  try {
    const res = await app.api.runJob({ key: "wt-cleanup-apply" });
    if (res.ok === false)
      return app.toast(res.error || "Could not start cleanup.", "danger");
    app.store.openJobId = res.jobId;
    app.store.jobLogs[res.jobId] = [];
    app.toast("Cleanup started, streaming to Commands.", "info");
    app.navigate("#/commands");
  } catch (err) {
    app.toast(`Could not start: ${err.message}`, "danger");
  }
}

async function deleteRemoteBranch(app, branch) {
  if (
    !confirm(
      `Delete ${branch} on origin? This pushes a deletion to the remote and cannot be undone.`,
    )
  )
    return;
  try {
    const res = await app.api.action("remote.deleteBranch", { branch });
    app.toast(
      res.ok ? `Deleted ${branch} on origin.` : res.error || "Delete failed.",
      res.ok ? "ok" : "danger",
    );
  } catch (err) {
    app.toast(`Delete failed: ${err.message}`, "danger");
  }
}
