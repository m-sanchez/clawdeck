// @ts-check
import { el, card, pill } from "../lib/dom.mjs";

const MARK = {
  done: "✓",
  current: "•",
  blocked: "✕",
  pending: "○",
  skipped: "–",
};
const TONE = {
  done: "ok",
  current: "info",
  blocked: "danger",
  pending: "neutral",
  skipped: "neutral",
};
const AXIS_TONE = { READY: "ok", BLOCKED: "danger", UNKNOWN: "warn" };
const AXIS_LABEL = {
  remoteMerge: "Remote change",
  localDelivery: "Local work",
};
const AXIS_SUB = {
  remoteMerge: "what the provider needs before it will merge",
  localDelivery: "what is still only on this machine",
};

function stageBox(s) {
  return el("div", { class: `cp-stage state-${s.state}` }, [
    el("div", { class: "cp-row" }, [
      el("span", { text: MARK[s.state] || "○" }),
      el("strong", { class: "small", text: s.label }),
    ]),
    el("div", { class: "muted small", text: s.detail || "" }),
    pill(s.state, TONE[s.state] || "neutral"),
  ]);
}

/** Reasons under an axis verdict, kept as the derivation wrote them. */
function reasonList(title, entries, tone) {
  if (!entries?.length) return null;
  return el("div", { class: "cp-axis-reasons" }, [
    el("div", { class: "muted small", text: title }),
    el(
      "ul",
      { class: "cp-reasons" },
      entries.map((e) =>
        el("li", {}, [
          pill(tone === "danger" ? "blocks" : "unknown", tone),
          el("span", { text: e.title }),
          e.reason
            ? el("span", { class: "muted small", text: e.reason })
            : null,
        ]),
      ),
    ),
  ]);
}

/**
 * One axis. UNKNOWN is rendered as its own verdict, never as a soft READY:
 * "I cannot show that you can merge" is not "you can merge".
 */
function axisBox(axis, value) {
  const state = value?.state ?? "UNKNOWN";
  return el("div", { class: `cp-axis state-${state.toLowerCase()}` }, [
    el("div", { class: "cp-row" }, [
      el("strong", { text: AXIS_LABEL[axis] }),
      pill(state, AXIS_TONE[state] || "neutral"),
    ]),
    el("div", { class: "muted small", text: AXIS_SUB[axis] }),
    reasonList("Blocking", value?.blocking, "danger"),
    reasonList("Not established", value?.unknown, "warn"),
    !value?.blocking?.length && !value?.unknown?.length
      ? el("div", {
          class: "muted small",
          text: "Nothing outstanding on this axis.",
        })
      : null,
  ]);
}

/** Which authority said it, so a git fact never reads as a provider verdict. */
function blockerRow(b) {
  const axes = ["remoteMerge", "localDelivery"]
    .filter((a) => b.blocking?.[a] !== false)
    .map((a) => `${AXIS_LABEL[a]}: ${b.blocking[a] === true ? "blocks" : "?"}`)
    .join(" · ");
  const why = el("details", { class: "cp-why" }, [
    el("summary", { class: "small", text: "Why?" }),
    el(
      "ul",
      { class: "cp-reasons" },
      [
        ...Object.entries(b.blockingReason || {}).map(([axis, reason]) =>
          el("li", { text: `${AXIS_LABEL[axis] || axis}: ${reason}` }),
        ),
        ...(b.evidence || []).map((e) =>
          el("li", { text: `${e.kind}: ${e.note}` }),
        ),
        b.coverage && b.coverage.complete === false
          ? el("li", {
              text: `coverage incomplete: ${b.coverage.reason || "unstated"}`,
            })
          : null,
      ].filter(Boolean),
    ),
  ]);
  return el("div", { class: "cp-blocker" }, [
    el("div", { class: "cp-row" }, [
      pill(b.authority, b.needsHuman ? "warn" : "neutral"),
      el("strong", { text: b.title }),
      b.freshness === "stale" ? pill("stale", "warn") : null,
    ]),
    b.detail ? el("div", { class: "muted small", text: b.detail }) : null,
    el("div", { class: "muted small", text: axes }),
    why,
  ]);
}

/**
 * A failing check, with the two things an engineer wants next: what it printed,
 * and a scoped task to work on it. The log is fetched on demand - it is
 * unbounded third-party text and never rides the snapshot.
 */
function ciFailureRow(app, ci, f) {
  const out = el("div", { class: "cp-log" });
  const load = async () => {
    const job = f.jobId ?? f.id;
    out.replaceChildren(el("div", { class: "muted small", text: "Loading…" }));
    const r = await app.api.ciLog(job);
    if (r?.refused) {
      out.replaceChildren(
        el("div", { class: "small", text: `Withheld: ${r.reason}` }),
      );
      return;
    }
    if (!r?.ok) {
      out.replaceChildren(
        el("div", {
          class: "small",
          text: `Log unavailable: ${r?.reason ?? "unknown"}`,
        }),
      );
      return;
    }
    const attribution = r.attribution?.attributed
      ? `Likely from task ${r.attribution.taskId} (${r.attribution.sharedFiles.join(", ")})`
      : (r.attribution?.reason ?? "No reliable attribution.");
    out.replaceChildren(
      el("div", { class: "muted small", text: attribution }),
      el("pre", { class: "cp-pre", text: r.text }),
      el("div", {
        class: "muted small",
        text: r.truncated
          ? `tail of ${r.totalChars} characters`
          : `${r.totalChars} characters`,
      }),
    );
  };

  return el("div", { class: "cp-blocker" }, [
    el("div", { class: "cp-row" }, [
      pill("failing", "danger"),
      el("strong", { text: f.name }),
      el("span", { class: "muted small", text: f.source ?? "" }),
    ]),
    el("div", { class: "cp-row" }, [
      f.inspectable
        ? el("button", {
            class: "btn btn-sm",
            type: "button",
            text: "View output",
            onClick: load,
          })
        : el("span", {
            class: "muted small",
            text: "no log Clawdeck can fetch for this check",
          }),
      f.inspectable
        ? el("button", {
            class: "btn btn-sm",
            type: "button",
            text: "Fix locally",
            onClick: async () => {
              const r = await app.api.action("ci.fix", {
                job: String(f.jobId ?? f.id),
              });
              if (r?.refused) return app.toast(`Refused: ${r.reason}`, "danger");
              if (r?.ok === false) return app.toast(r.error, "danger");
              app.toast(`Task ${r.taskId} ready; submit the prompt to start.`);
              if (r.url) window.open(r.url, "_blank", "noopener");
            },
          })
        : null,
      f.detailsUrl
        ? el("a", {
            class: "btn btn-sm",
            href: f.detailsUrl,
            target: "_blank",
            rel: "noopener",
            text: "Open on provider",
          })
        : null,
    ]),
    out,
  ]);
}

/** Delivery Readiness: two axes, the blockers behind them, and the lifecycle. */
export function render(app) {
  const d = app.snapshot?.delivery || {
    stages: [],
    blockers: [],
    nextAction: "",
    hasChanges: false,
  };
  const r = app.snapshot?.deliveryReadiness || null;
  const ci = app.snapshot?.ci || null;

  const banner = el("div", { class: "cp-banner" }, [
    pill(
      r ? r.headline : "next",
      r ? AXIS_TONE[r.headline] || "neutral" : d.hasChanges ? "info" : "ok",
    ),
    el("strong", { text: d.nextAction }),
    ci?.summary
      ? el("span", {
          class: "muted small",
          text: `CI ${ci.summary.state}${ci.ref ? ` @ ${String(ci.ref).slice(0, 7)}` : ""}${
            ci.summary.native ? " (native contexts only)" : ""
          }`,
        })
      : null,
  ]);

  const axes = r
    ? card(
        "Readiness",
        el("div", { class: "cp-axes" }, [
          axisBox("remoteMerge", r.remoteMerge),
          axisBox("localDelivery", r.localDelivery),
        ]),
      )
    : null;

  const failing = (ci?.failures || []).length
    ? card(
        `Failing checks (${ci.failureCount ?? ci.failures.length})`,
        el(
          "div",
          { class: "cp-rows" },
          ci.failures.map((f) => ciFailureRow(app, ci, f)),
        ),
      )
    : null;

  const blockers = r?.blockers?.length
    ? card(
        `Blockers (${r.blockers.length})`,
        el("div", { class: "cp-rows" }, r.blockers.map(blockerRow)),
      )
    : d.blockers.length
      ? card(
          "Blockers",
          el(
            "div",
            { class: "cp-rows" },
            d.blockers.map((b) =>
              el("div", { class: "cp-row" }, [
                pill("blocker", "danger"),
                el("span", { text: b }),
              ]),
            ),
          ),
        )
      : null;

  return el(
    "div",
    { class: "view cp-view" },
    [
      banner,
      axes,
      failing,
      blockers,
      card("Delivery lifecycle", [
        el("div", { class: "cp-steps" }, d.stages.map(stageBox)),
      ]),
    ].filter(Boolean),
  );
}
