// @ts-check
import {
  el,
  card,
  pill,
  statusTone,
  absTime,
  emptyState,
  worktreeSelect,
} from "../lib/dom.mjs";
import { donut } from "../lib/charts.mjs";

/** Validation, deterministic gate results (tsc/eslint/prettier/jest) by project. */
export function render(app) {
  const target = app.store.scanTarget || "";
  // Fetch the scoped report for the selected worktree when it changes.
  if (target && app.store._valTarget !== target) {
    app.store._valTarget = target;
    app.api.validation(target).then(
      (x) => {
        app.store.scopedValidation = x;
        app.rerender();
      },
      () => {},
    );
  }
  const v = target
    ? app.store.scopedValidation || { status: "none", checks: [] }
    : (app.snapshot?.validation ?? { status: "none", checks: [] });
  const running = app.store.validationRunning;

  const head = el("div", { class: "toolbar" }, [
    el("label", { class: "inline-field" }, [
      el("span", { text: "Scope" }),
      worktreeSelect(app, target, (val) => selectTarget(app, val)),
    ]),
    el("button", {
      class: "btn btn-primary",
      text: running ? "Running…" : "Run validation",
      disabled: running ? true : null,
      onClick: () => run(app, target),
    }),
    v.ranAt
      ? el("span", {
          class: "muted small",
          text: `last run ${absTime(v.ranAt)}${v.base ? ` · base ${v.base}` : ""}${v.worktree ? ` · ${v.worktree}` : ""}`,
        })
      : null,
  ]);

  let body;
  if (v.status === "none" && !running) {
    body = emptyState(
      "Validation has not been run for this checkout yet.",
      "Run validation to execute the repository gate (tsc, eslint, prettier, jest) over the change set. Requires the node_modules junction (/wt-setup).",
    );
  } else if (!v.checks.length && running) {
    body = el("div", { class: "running-note" }, [
      el("span", { class: "spinner" }),
      el("span", {
        text: "Running the repository verify gate… streaming to Logs.",
      }),
    ]);
  } else if (!v.checks.length) {
    body = emptyState(
      "No checks in scope.",
      "The change set produced no applicable checks.",
    );
  } else {
    const byProject = group(v.checks);
    const counts = {
      passed: v.checks.filter((c) => c.status === "passed").length,
      failed: v.checks.filter((c) => c.status === "failed").length,
      skipped: v.checks.filter((c) => c.status === "skipped").length,
    };
    const donutEl = el("div", { class: "donut-host" });
    queueMicrotask(() =>
      donut(
        donutEl,
        [
          { label: "passed", value: counts.passed, tone: "ok" },
          { label: "failed", value: counts.failed, tone: "danger" },
          { label: "skipped", value: counts.skipped, tone: "neutral" },
        ],
        { centerLabel: "checks" },
      ),
    );
    const summary = el("div", { class: "evidence-split" }, [
      donutEl,
      el("div", { class: "legend" }, [
        legend("passed", "ok", counts.passed),
        legend("failed", "danger", counts.failed),
        legend("skipped", "neutral", counts.skipped),
      ]),
    ]);
    const tables = Object.entries(byProject).map(([project, checks]) =>
      el("div", { class: "val-project" }, [
        el("h3", { class: "val-project-name", text: project }),
        el("table", { class: "data-table compact" }, [
          el(
            "thead",
            {},
            el("tr", {}, [
              el("th", { text: "Check" }),
              el("th", { text: "Blocking" }),
              el("th", { text: "Status" }),
              el("th", { text: "Detail" }),
            ]),
          ),
          el(
            "tbody",
            {},
            checks.map((c) =>
              el("tr", {}, [
                el("td", { class: "mono small", text: c.label }),
                el(
                  "td",
                  {},
                  c.blocking
                    ? pill("blocking", "danger")
                    : pill("advisory", "neutral"),
                ),
                el("td", {}, pill(c.status, statusTone(c.status))),
                el("td", { class: "small" }, [
                  el("span", { text: c.summary || "·" }),
                  c.status === "failed" ? fixAction(app, c, target) : null,
                ]),
              ]),
            ),
          ),
        ]),
      ]),
    );
    body = el("div", {}, [summary, ...tables]);
  }

  const verdict =
    v.status === "ok"
      ? v.checks.length === 0
        ? pill("no scope", "neutral")
        : v.passed
          ? pill("passing", "ok")
          : pill("failing", "danger")
      : null;
  return el(
    "div",
    { class: "view view-validation" },
    card("Validation", [head, validationTrend(v), body], { aside: verdict }),
  );
}

/** A strip of the last N validation outcomes, green (ok) or red (failed). */
function validationTrend(v) {
  const h = v.history || [];
  if (h.length < 2) return null;
  const dots = h.map((r) =>
    el("span", {
      class: `val-dot ${r.ok ? "ok" : "bad"}`,
      "data-tip": `${absTime(r.ranAt)}: ${r.passed} passed, ${r.failed} failed`,
    }),
  );
  const okCount = h.filter((r) => r.ok).length;
  return el("div", { class: "val-trend" }, [
    el("span", { class: "muted small", text: `Last ${h.length} runs` }),
    el("div", { class: "val-dots" }, dots),
    el("span", {
      class: "muted small mono",
      text: `${okCount}/${h.length} ok`,
    }),
  ]);
}

function group(checks) {
  const out = {};
  for (const c of checks) (out[c.project || "general"] ||= []).push(c);
  return out;
}

function legend(label, tone, value) {
  return el("div", { class: "legend-row" }, [
    el("span", { class: `legend-dot tone-${tone}` }),
    el("span", { class: "legend-label", text: label }),
    el("span", { class: "legend-value mono", text: String(value) }),
  ]);
}

/**
 * Map a failed check to a concrete remedy. Format/lint failures are fixed in
 * place by the panel's fix-lint job; everything else becomes a copyable
 * /implement prompt to paste into a Claude session (the panel runs no agent).
 */
function fixAction(app, check, target) {
  const label = String(check.label || "").toLowerCase();
  const project =
    check.project && check.project !== "(runner)" ? check.project : "";
  if (/prettier|format|eslint|lint/.test(label)) {
    return el("button", {
      class: "chip fix-chip",
      "data-tip":
        "Run prettier + eslint --fix over the change set (writes files)",
      text: "Fix: run fix-lint",
      onClick: () => runFix(app, "fix-lint", target),
    });
  }
  if (check.id === "verify:execution") {
    return el("button", {
      class: "chip fix-chip ghost",
      "data-tip":
        "Verify could not run, usually the node_modules junction is missing",
      text: "Copy /wt-setup",
      onClick: () => copyText(app, "/wt-setup"),
    });
  }
  const kind = /tsc|type/.test(label)
    ? "type errors"
    : /jest|test|spec/.test(label)
      ? "failing tests"
      : "failing check";
  const prompt = `/implement fix the ${kind} reported by validation${project ? ` in ${project}` : ""}: ${check.summary || check.label}`;
  return el("button", {
    class: "chip fix-chip ghost",
    "data-tip": "Copy a ready-to-paste fix prompt for your Claude session",
    text: "Copy fix prompt",
    onClick: () => copyText(app, prompt),
  });
}

async function runFix(app, key, target) {
  try {
    const res = await app.api.runJob({
      key,
      worktreePath: target || undefined,
    });
    if (res.ok === false)
      return app.toast(res.error || "Could not start fix.", "danger");
    app.store.openJobId = res.jobId;
    app.store.jobLogs[res.jobId] = [];
    app.toast(
      `${res.job?.label || key} started, re-run validation when it finishes.`,
      "info",
    );
    app.navigate("#/commands");
  } catch (err) {
    app.toast(`Could not start fix: ${err.message}`, "danger");
  }
}

function copyText(app, text) {
  navigator.clipboard?.writeText(text).then(
    () => app.toast(`Copied: ${text}`, "ok"),
    () => app.toast("Clipboard unavailable.", "warn"),
  );
}

function selectTarget(app, val) {
  app.store.scanTarget = val;
  app.store._valTarget = null; // force a scoped re-fetch on next render
  app.rerender();
}

async function run(app, target) {
  app.store.validationRunning = true;
  app.updateClawd?.();
  app.rerender();
  try {
    await app.api.action(
      "validation.run",
      target ? { worktreePath: target } : {},
    );
    app.toast("Validation started, watch Logs for progress.", "info");
    // Refresh the scoped report once the run finishes (verify is bounded).
    if (target) pollScoped(app, target);
  } catch (err) {
    app.store.validationRunning = false;
    app.updateClawd?.();
    app.rerender();
    app.toast(`Could not start validation: ${err.message}`, "danger");
  }
}

function pollScoped(app, target) {
  let tries = 0;
  const prev = app.store.scopedValidation?.ranAt || null;
  const timer = setInterval(async () => {
    tries += 1;
    try {
      const x = await app.api.validation(target);
      if (x.ranAt && x.ranAt !== prev) {
        app.store.scopedValidation = x;
        app.store.validationRunning = false;
        clearInterval(timer);
        if (app.store.scanTarget === target) app.rerender();
      }
    } catch {
      /* keep polling */
    }
    if (tries > 90) {
      clearInterval(timer);
      app.store.validationRunning = false;
    }
  }, 2000);
}
