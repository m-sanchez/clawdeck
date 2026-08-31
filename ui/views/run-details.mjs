// @ts-check
import {
  el,
  card,
  pill,
  statusTone,
  absTime,
  relTime,
  emptyState,
} from "../lib/dom.mjs";
import { fmtElapsed } from "./runs.mjs";

function copyText(text, app) {
  navigator.clipboard?.writeText(String(text)).then(
    () => app.toast("Run id copied.", "ok"),
    () => app.toast("Clipboard unavailable.", "warn"),
  );
}

function elapsedRow(run, app) {
  const live = run.status === "running" || run.status === "waiting";
  const cell = el("span", {
    class: "v mono",
    text: fmtElapsed(run.startedAt, live),
  });
  if (live)
    app.store.tickers.push(
      () => (cell.textContent = fmtElapsed(run.startedAt, true)),
    );
  return el("div", { class: "kv" }, [
    el("span", { class: "k", text: "Elapsed" }),
    cell,
  ]);
}

function worktreeRow(run, app) {
  const wt = (app.snapshot?.worktrees ?? []).find(
    (w) => run.branch && w.branch === run.branch,
  );
  if (!wt) return null;
  return el("div", { class: "kv" }, [
    el("span", { class: "k", text: "Worktree" }),
    el(
      "span",
      { class: "v" },
      el("button", {
        class: "link-btn mono",
        text: wt.branch,
        onClick: () => app.navigate("#/worktrees"),
      }),
    ),
  ]);
}

/** Run details, execution timeline + evidence, cross-linked to the other views. */
export function render(app) {
  const id = app.params.id;
  const container = el("div", { class: "view view-run-details" }, [
    el("button", {
      class: "link-btn",
      text: "← All runs",
      onClick: () => app.navigate("#/runs"),
    }),
    el("div", { class: "detail-slot" }, emptyState("Loading run…")),
  ]);
  const slot = container.querySelector(".detail-slot");

  app.api
    .run(id)
    .then((run) => {
      slot.replaceChildren(detail(run, app));
    })
    .catch((err) => {
      slot.replaceChildren(
        card("Run not found", emptyState(err.message, `No run with id ${id}.`)),
      );
    });

  return container;
}

function detail(run, app) {
  const pct = run.progress != null ? Math.round(run.progress * 100) : 0;
  const summary = card("Run", [
    el("div", { class: "detail-head" }, [
      el("h2", { class: "detail-title", text: run.title }),
      pill(
        run.stale ? "stale" : run.status,
        run.stale ? "warn" : statusTone(run.status),
      ),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "k", text: "Id" }),
      el("span", { class: "v" }, [
        el("span", { class: "mono", text: run.id }),
        el("button", {
          class: "link-btn",
          text: "copy",
          "data-tip": "Copy run id",
          onClick: () => copyText(run.id, app),
        }),
      ]),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "k", text: "Kind" }),
      el("span", { class: "v", text: run.kind || "run" }),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "k", text: "Phase" }),
      el("span", { class: "v", text: run.phase }),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "k", text: "Iteration" }),
      el("span", {
        class: "v",
        text: `${run.iteration ?? "?"} / ${run.maxIterations ?? "?"}`,
      }),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "k", text: "Started" }),
      el("span", { class: "v", text: absTime(run.startedAt) }),
    ]),
    elapsedRow(run, app),
    worktreeRow(run, app),
    run.scope
      ? el("div", { class: "kv" }, [
          el("span", { class: "k", text: "Scope" }),
          el("span", { class: "v", text: run.scope }),
        ])
      : null,
    run.stoppingCondition
      ? el("div", { class: "kv" }, [
          el("span", { class: "k", text: "Stopped by" }),
          el("span", { class: "v", text: run.stoppingCondition }),
        ])
      : null,
    run.failureReason
      ? el("div", { class: "kv" }, [
          el("span", { class: "k", text: "Failure" }),
          el("span", { class: "v danger", text: run.failureReason }),
        ])
      : null,
    el(
      "div",
      { class: "progress", "data-tip": `${pct}%` },
      el("div", { class: "progress-bar", style: `width:${pct}%` }),
    ),
    run.status === "running" || run.status === "waiting"
      ? el("button", {
          class: "btn btn-danger",
          text: "Cancel run",
          onClick: () => cancel(run, app),
        })
      : null,
  ]);

  const timeline = card(
    "Execution timeline",
    (run.timeline ?? []).length
      ? el(
          "ol",
          { class: "timeline" },
          run.timeline.map((t) =>
            el(
              "li",
              {
                class: `timeline-item ${t.progressed ? "progressed" : "idle-step"}`,
              },
              [
                el("span", { class: "timeline-dot" }),
                el("div", {}, [
                  el("strong", { text: `Iteration ${t.iteration}` }),
                  pill(
                    t.progressed ? "progress" : "no change",
                    t.progressed ? "ok" : "neutral",
                  ),
                  el("div", {
                    class: "muted small",
                    text: `${absTime(t.at)} · ${relTime(t.at)}`,
                  }),
                  t.evidence
                    ? el("div", { class: "small", text: String(t.evidence) })
                    : null,
                ]),
              ],
            ),
          ),
        )
      : emptyState("No iterations recorded yet."),
  );

  const evidence = card("Evidence", [
    el("p", { class: "muted small", text: "Last recorded progress evidence:" }),
    el("pre", {
      class: "evidence",
      text: run.lastEvidence ? String(run.lastEvidence) : "(none)",
    }),
  ]);

  const links = card(
    "Related",
    el("div", { class: "btn-row" }, [
      el("button", {
        class: "btn",
        text: "Validation",
        onClick: () => app.navigate("#/validation"),
      }),
      el("button", {
        class: "btn",
        text: "Reviews",
        onClick: () => app.navigate("#/reviews"),
      }),
      el("button", {
        class: "btn",
        text: "Logs",
        onClick: () => app.navigate("#/logs"),
      }),
    ]),
  );

  return el("div", { class: "grid grid-2 stretch" }, [
    el("div", {}, [summary, links]),
    el("div", {}, [timeline, evidence]),
  ]);
}

async function cancel(run, app) {
  if (!confirm(`Cancel run "${run.title}"?`)) return;
  try {
    await app.api.action("run.cancel", { runId: run.id });
    app.toast("Run cancelled.", "ok");
    app.navigate(`#/runs/${run.id}`);
    app.rerender();
  } catch (err) {
    app.toast(`Cancel failed: ${err.message}`, "danger");
  }
}
