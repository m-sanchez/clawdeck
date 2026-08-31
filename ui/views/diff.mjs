// @ts-check
/**
 * Branch diff viewer: the files changed between the review base and HEAD, with a
 * clickable list and a per-file unified diff. Same base resolution as the review
 * pack, so what shows here is what a pack would contain. Read-only; the server
 * runs `git diff base...HEAD -- <file>` with a validated pathspec.
 */
import { el, card, clear } from "../lib/dom.mjs";

export function render(app) {
  const worktrees = app.snapshot?.worktrees ?? [];
  const target = app.store.diffTarget || "";
  const mode = app.store.diffMode === "working" ? "working" : "committed";

  const modeBtn = (key, label, tip) =>
    el("button", {
      class: `tab ${mode === key ? "active" : ""}`,
      type: "button",
      "data-tip": tip,
      text: label,
      onClick: () => {
        app.store.diffMode = key;
        app.store.diffFile = "";
        app.rerender();
      },
    });
  const modeToggle = el("div", { class: "tabstrip diff-modes" }, [
    modeBtn(
      "committed",
      "Committed",
      "Commits on this branch vs the review base.",
    ),
    modeBtn(
      "working",
      "Working tree",
      "Uncommitted changes (staged, unstaged, untracked) in the worktree.",
    ),
  ]);

  const picker =
    worktrees.length > 0
      ? el("label", { class: "field" }, [
          el("span", { class: "field-label", text: "Worktree" }),
          /** @type {HTMLSelectElement} */ (
            el(
              "select",
              {
                class: "input",
                onChange: (e) => {
                  app.store.diffTarget = /** @type {HTMLSelectElement} */ (
                    e.target
                  ).value;
                  app.store.diffFile = "";
                  app.rerender();
                },
              },
              [
                el("option", { value: "", text: "Current checkout" }),
                ...worktrees.map((w) =>
                  el("option", {
                    value: w.path,
                    text: `${w.branch}${w.isCurrent ? " (this)" : ""}`,
                    selected: w.path === target ? true : null,
                  }),
                ),
              ],
            )
          ),
        ])
      : null;

  const listHost = el("div", { class: "diff-file-list" }, [
    el("span", { class: "muted small", text: "Loading changed files…" }),
  ]);
  const bodyHost = el("div", { class: "diff-body" }, [
    el("p", {
      class: "muted small",
      text: "Select a file to see its diff.",
    }),
  ]);
  const headHost = el("div", { class: "diff-head small muted" });

  loadFiles(app, target, mode, headHost, listHost, bodyHost);

  return el("div", { class: "view view-diff" }, [
    card("Branch diff", [
      el("p", {
        class: "muted small",
        text: "Committed changes vs the review base, or uncommitted work in the worktree. Read-only.",
      }),
      modeToggle,
      picker,
      headHost,
      el("div", { class: "diff-split" }, [listHost, bodyHost]),
    ]),
  ]);
}

async function loadFiles(app, target, mode, headHost, listHost, bodyHost) {
  let files = [];
  let headText = "";
  let emptyText = "";
  try {
    if (mode === "working") {
      const d = await app.api.workingTree(target);
      files = (d.files || []).map((f) => ({ path: f.path, status: f.status }));
      headText = files.length ? `${files.length} uncommitted file(s)` : "";
      emptyText = "No uncommitted changes in this worktree.";
    } else {
      const d = await app.api.reviewPackPreview(target);
      files = (d.files || []).map((f) => ({
        path: f.path,
        added: f.added,
        removed: f.removed,
      }));
      headText = d.totalFiles
        ? `${d.totalFiles} files · +${d.totalAdded} / -${d.totalRemoved} · base ${d.base} (${d.baseSha})`
        : "";
      emptyText = `No committed changes vs ${d?.base || "base"}.`;
    }
  } catch (e) {
    clear(listHost).append(errBox(String((e && e.message) || e)));
    return;
  }
  if (!files.length) {
    clear(headHost);
    clear(listHost).append(el("p", { class: "muted small", text: emptyText }));
    clear(bodyHost).append(
      el("p", { class: "muted small", text: "Nothing to show." }),
    );
    return;
  }
  clear(headHost).append(el("span", { text: headText }));
  const rightCell = (f) =>
    mode === "working"
      ? el("span", {
          class: `diff-status st-${(f.status || "?")[0]}`,
          text: f.status,
        })
      : el("span", { class: "diff-file-counts mono small" }, [
          el("span", {
            class: "diff-add",
            text: f.added == null ? "bin" : `+${f.added}`,
          }),
          el("span", {
            class: "diff-del",
            text: f.removed == null ? "" : `-${f.removed}`,
          }),
        ]);
  const rows = files.map((f) => {
    const row = el(
      "button",
      { class: "diff-file", type: "button", dataset: { path: f.path } },
      [
        el("span", { class: "diff-file-path mono small", text: f.path }),
        rightCell(f),
      ],
    );
    row.addEventListener("click", () => {
      for (const r of listHost.querySelectorAll(".diff-file.active"))
        r.classList.remove("active");
      row.classList.add("active");
      app.store.diffFile = f.path;
      loadOne(app, target, mode, f.path, bodyHost);
    });
    if (f.path === app.store.diffFile) row.classList.add("active");
    return row;
  });

  // Filter the file list by path substring (handy on a wide branch diff).
  const filter = /** @type {HTMLInputElement} */ (
    el("input", {
      class: "input search diff-filter",
      type: "search",
      placeholder: `Filter ${files.length} files…`,
      value: app.store.diffFilter || "",
    })
  );
  const empty = el("p", {
    class: "muted small",
    hidden: true,
    text: "No files match.",
  });
  const applyFilter = () => {
    const q = filter.value.trim().toLowerCase();
    app.store.diffFilter = filter.value;
    let shown = 0;
    for (const row of rows) {
      const match = !q || row.dataset.path.toLowerCase().includes(q);
      row.hidden = !match;
      if (match) shown++;
    }
    empty.hidden = shown > 0;
  };
  filter.addEventListener("input", applyFilter);
  clear(listHost).append(filter, ...rows, empty);
  applyFilter();
  if (app.store.diffFile && files.some((f) => f.path === app.store.diffFile))
    loadOne(app, target, mode, app.store.diffFile, bodyHost);
}

async function loadOne(app, target, mode, file, bodyHost) {
  clear(bodyHost).append(
    el("div", { class: "df-running" }, [
      el("span", { class: "spinner-inline" }),
      el("span", { class: "muted small", text: "Loading diff…" }),
    ]),
  );
  let res;
  try {
    res = await app.api.fileDiff(
      file,
      target,
      mode === "working" ? "working" : undefined,
    );
  } catch (e) {
    clear(bodyHost).append(errBox(String((e && e.message) || e)));
    return;
  }
  if (!bodyHost.isConnected) return;
  renderUnified(app, target, bodyHost, file, res);
}

function openInEditor(app, target, file) {
  app.api
    .action("editor.open", { file, worktreePath: target || undefined })
    .then((r) =>
      app.toast(
        r.ok ? "Opening in editor…" : r.error || "Could not open.",
        r.ok ? "ok" : "danger",
      ),
    )
    .catch((e) => app.toast(`Could not open: ${e.message}`, "danger"));
}

function renderUnified(app, target, bodyHost, file, res) {
  clear(bodyHost);
  const head = el("div", { class: "diff-body-head" }, [
    el("span", { class: "diff-file-title mono small", text: file }),
    el("button", {
      class: "btn ghost",
      "data-tip": "Open this file in VS Code on the panel host.",
      text: "Open in editor",
      onClick: () => openInEditor(app, target, file),
    }),
  ]);
  const text = (res && res.diff) || "";
  if (!text.trim()) {
    bodyHost.append(
      head,
      el("p", {
        class: "muted small",
        text: "No textual diff (binary, renamed, or unchanged).",
      }),
    );
    return;
  }
  const lines = text.split(/\r?\n/);
  const frag = lines.map((line) => {
    let cls = "diff-line";
    if (line.startsWith("@@")) cls += " hunk";
    else if (
      /^(diff --git|index |--- |\+\+\+ |new file|deleted file|rename )/.test(
        line,
      )
    )
      cls += " meta";
    else if (line.startsWith("+")) cls += " add";
    else if (line.startsWith("-")) cls += " del";
    return el("div", { class: cls, text: line || " " });
  });
  bodyHost.append(head, el("div", { class: "diff-view mono" }, frag));
}

function errBox(msg) {
  return el("div", { class: "inspector-error" }, [
    el("strong", { text: "Error" }),
    el("div", { class: "muted small", text: msg }),
  ]);
}
