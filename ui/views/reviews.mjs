// @ts-check
import {
  el,
  card,
  pill,
  emptyState,
  worktreeSelect,
  absTime,
  actionMenu,
} from "../lib/dom.mjs";
import { bars } from "../lib/charts.mjs";

const SEV_TONE = {
  blocking: "danger",
  high: "danger",
  medium: "warn",
  low: "neutral",
  advisory: "neutral",
};
const SEV_ORDER = { blocking: 0, high: 1, medium: 2, low: 3, advisory: 4 };

/** Reviews, deterministic scanner findings for the branch diff, by severity. */
export function render(app) {
  const target = app.store.scanTarget || "";
  const r = target
    ? app.store.scopedReviews || { status: "pending", findings: [] }
    : (app.snapshot?.reviews ?? { status: "pending", findings: [] });
  const running = app.store.reviewRunning;

  const readiness =
    r.status !== "ok"
      ? pill(r.status, "neutral")
      : r.blockCount > 0
        ? pill(`${r.blockCount} blocking`, "danger")
        : r.warnCount > 0
          ? pill(`${r.warnCount} warnings`, "warn")
          : pill("no findings", "ok");

  const selector = worktreeSelect(app, target, (v) => selectTarget(app, v));
  const head = el("div", { class: "toolbar" }, [
    el("label", { class: "inline-field" }, [
      el("span", { text: "Scope" }),
      selector,
    ]),
    el("button", {
      class: "btn btn-primary",
      text: running ? "Scanning…" : "Re-run review scan",
      disabled: running ? true : null,
      onClick: () => (target ? rescan(app, target) : run(app)),
    }),
    r.status === "ok" && r.findings?.length
      ? el("button", {
          class: "btn btn-ghost",
          "data-tip":
            "Copy a prompt that tasks a Claude session with resolving every finding here",
          text: "Fix all findings →",
          onClick: () =>
            copyText(
              app,
              `/implement resolve the ${r.findings.length} review finding(s) on this branch listed in Clawdeck (rules: ${[...new Set(r.findings.map((f) => f.ruleId).filter(Boolean))].join(", ") || "see review-readiness"}). Fix the root cause, do not suppress.`,
            ),
        })
      : null,
    r.base
      ? el("span", {
          class: "muted small",
          text: `base ${r.base}${r.worktree ? ` · ${r.worktree}` : ""}`,
        })
      : null,
  ]);

  let body;
  if (r.status === "scanning" || r.status === "pending") {
    body = el("div", { class: "running-note" }, [
      el("span", { class: "spinner" }),
      el("span", { text: "Scanning the branch diff…" }),
    ]);
  } else if (r.status === "unavailable") {
    body = emptyState(
      "Review pipeline not present in this checkout.",
      r.message || "",
    );
  } else if (r.status === "error") {
    body = emptyState("Could not determine the branch diff.", r.message || "");
  } else if (!r.findings?.length) {
    body = emptyState(
      "No findings on the branch diff.",
      "Readiness is based on the same deterministic scanner the pre-push hook uses, not an opaque score.",
    );
  } else {
    const sev = app.store.reviewSeverity || "all";
    const counts = {};
    for (const f of r.findings)
      counts[f.severity] = (counts[f.severity] || 0) + 1;
    const barEl = el("div", { class: "bar-host" });
    queueMicrotask(() =>
      bars(
        barEl,
        Object.keys(SEV_ORDER)
          .filter((s) => counts[s])
          .map((s) => ({
            label: s,
            value: counts[s],
            tone: SEV_TONE[s] || "neutral",
          })),
      ),
    );
    const filters = el("div", { class: "chips" }, [
      filterChip(app, "all", `All (${r.findings.length})`, sev),
      ...Object.keys(SEV_ORDER)
        .filter((s) => counts[s])
        .map((s) => filterChip(app, s, `${s} (${counts[s]})`, sev)),
    ]);
    const sorted = [...r.findings]
      .filter((f) => sev === "all" || f.severity === sev)
      .sort(
        (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9),
      );
    const byFile = {};
    for (const f of sorted) (byFile[f.file || "(no file)"] ||= []).push(f);
    const groups = Object.entries(byFile).map(([file, items]) =>
      el("details", { class: "finding-group", open: true }, [
        el("summary", {}, [
          el("span", { class: "group-file", text: file }),
          el("span", {
            class: "muted small",
            text: `${items.length} finding${items.length === 1 ? "" : "s"}`,
          }),
        ]),
        el(
          "ul",
          { class: "finding-list" },
          items.map((f) => findingItem(f, app, target)),
        ),
      ]),
    );
    body = el("div", { class: "reviews-body" }, [
      el("div", { class: "review-summary" }, barEl),
      ruleSummary(r.findings),
      filters,
      el("div", { class: "finding-groups" }, groups),
    ]);
  }

  return el(
    "div",
    { class: "view view-reviews" },
    card("Review findings", [head, reviewTrend(app, target), body], {
      aside: readiness,
    }),
  );
}

/** Counts per ruleId, highest first, so triage sees which rules fire most. */
function ruleSummary(findings) {
  const counts = {};
  for (const f of findings) {
    const k = f.ruleId || "(none)";
    counts[k] = (counts[k] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length < 2) return null; // a single rule needs no summary
  return el("div", { class: "rule-summary" }, [
    el("span", { class: "muted small", text: "By rule" }),
    ...entries.map(([rule, n]) =>
      el("span", { class: "rule-chip" }, [
        el("span", { class: "rule-chip-id mono small", text: rule }),
        el("span", { class: "rule-chip-n mono small", text: String(n) }),
      ]),
    ),
  ]);
}

/** Trend of the last N review scans for the current checkout (unscoped only). */
function reviewTrend(app, target) {
  if (target) return null; // history is recorded for the current checkout only
  const h = app.snapshot?.reviewHistory || [];
  if (h.length < 2) return null;
  const dots = h.map((r) =>
    el("span", {
      class: `val-dot ${r.blockCount > 0 ? "bad" : r.warnCount > 0 ? "warn" : "ok"}`,
      "data-tip": `${absTime(r.at)}: ${r.blockCount} blocking, ${r.warnCount} warnings`,
    }),
  );
  const clean = h.filter((r) => (r.blockCount || 0) === 0).length;
  return el("div", { class: "val-trend" }, [
    el("span", { class: "muted small", text: `Last ${h.length} scans` }),
    el("div", { class: "val-dots" }, dots),
    el("span", {
      class: "muted small mono",
      text: `${clean}/${h.length} no blockers`,
    }),
  ]);
}

function selectTarget(app, v) {
  app.store.scanTarget = v;
  if (v) rescan(app, v);
  else app.rerender();
}

function rescan(app, v) {
  app.store.scopedReviews = { status: "scanning", findings: [] };
  app.rerender();
  app.api.reviews(v).then(
    (x) => {
      app.store.scopedReviews = x;
      app.rerender();
    },
    (e) => {
      app.store.scopedReviews = {
        status: "error",
        message: e.message,
        findings: [],
      };
      app.rerender();
    },
  );
}

function findingItem(f, app, target) {
  return el(
    "li",
    { class: `finding sev-${SEV_TONE[f.severity] || "neutral"}` },
    [
      el("div", { class: "finding-head" }, [
        pill(f.severity, SEV_TONE[f.severity] || "neutral"),
        f.ruleId
          ? el("span", { class: "mono small chip-static", text: f.ruleId })
          : null,
        f.line
          ? el("span", { class: "muted small mono", text: `:${f.line}` })
          : null,
        f.resolved ? pill("resolved", "ok") : null,
        f.file && f.line
          ? actionMenu(
              [
                {
                  label: "Copy command",
                  onClick: () => copyText(app, `code -g ${f.file}:${f.line}`),
                },
                {
                  label: "Open in VS Code",
                  onClick: () => openInEditor(app, target, f.file, f.line),
                },
              ],
              { label: "Open", class: "ghost" },
            )
          : null,
        f.resolved ? null : fixForFinding(app, f, target),
      ]),
      el("div", { class: "finding-title", text: f.title }),
    ],
  );
}

/**
 * Per-finding remedy. Formatting findings are fixable in place by fix-lint;
 * everything else becomes a precise copyable /implement prompt pointing at the
 * exact file:line and rule, so the user can paste it into a Claude session.
 */
function fixForFinding(app, f, target) {
  const rule = String(f.ruleId || "").toUpperCase();
  const at = `${f.file || "(file)"}${f.line ? `:${f.line}` : ""}`;
  if (/PRETTIER|FORMAT|FMT/.test(rule)) {
    return el("button", {
      class: "chip fix-chip",
      "data-tip":
        "Run prettier + eslint --fix over the change set (writes files)",
      text: "Fix: fix-lint",
      onClick: () => runFix(app, "fix-lint", target),
    });
  }
  const intent = remedyIntent(rule);
  const title = String(f.title || "").replace(/\s*\.\s*$/, "");
  const prompt = `/implement ${intent} at ${at}${f.ruleId ? ` (${f.ruleId})` : ""}: ${title}. Fix the root cause, do not suppress.`;
  return el("button", {
    class: "chip fix-chip ghost",
    "data-tip": "Copy a ready-to-paste fix prompt for your Claude session",
    text: "Copy fix prompt",
    onClick: () => copyText(app, prompt),
  });
}

function remedyIntent(rule) {
  if (rule.startsWith("LOG"))
    return "migrate the console.* call to the approved logger";
  if (rule.startsWith("COM")) return "remove the AI-slop / low-value comment";
  if (rule.startsWith("ANG"))
    return "convert to the modern Angular control-flow / signal API";
  if (rule.startsWith("ERR")) return "handle the discarded failure explicitly";
  if (rule.startsWith("DATE")) return "render the date via DateService";
  if (rule.startsWith("SUP")) return "fix or remove the invalid suppression";
  return "resolve the review finding";
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
      `${res.job?.label || key} started, re-run the scan when it finishes.`,
      "info",
    );
    app.navigate("#/commands");
  } catch (err) {
    app.toast(`Could not start fix: ${err.message}`, "danger");
  }
}

async function openInEditor(app, target, file, line) {
  try {
    const res = await app.api.action("editor.open", {
      worktreePath: target || undefined,
      file,
      line,
    });
    app.toast(
      res.ok ? "Opening in VS Code…" : res.error || "Could not open editor.",
      res.ok ? "ok" : "danger",
    );
  } catch (err) {
    app.toast(`Could not open: ${err.message}`, "danger");
  }
}

function copyText(app, text) {
  navigator.clipboard?.writeText(text).then(
    () => app.toast("Fix prompt copied.", "ok"),
    () => app.toast("Clipboard unavailable.", "warn"),
  );
}

function filterChip(app, key, label, active) {
  return el("button", {
    class: `chip ${active === key ? "active" : ""}`,
    text: label,
    onClick: () => {
      app.store.reviewSeverity = key;
      app.rerender();
    },
  });
}

async function run(app) {
  app.store.reviewRunning = true;
  app.updateClawd?.();
  app.rerender();
  try {
    await app.api.action("review.run", {});
    app.toast("Review scan complete.", "ok");
    app.pulseClawd?.("success", "Review scan complete.", 3500);
  } catch (err) {
    app.toast(`Review scan failed: ${err.message}`, "danger");
    app.pulseClawd?.("blocked", "Review scan failed.", 3500);
  } finally {
    app.store.reviewRunning = false;
    app.updateClawd?.();
    app.rerender();
  }
}
