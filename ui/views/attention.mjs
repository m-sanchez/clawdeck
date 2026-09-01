// @ts-check
import { el, card, pill } from "../lib/dom.mjs";

const TONE = { blocking: "danger", attention: "warn", warning: "neutral" };

/**
 * One item, with the authority that put it here. A `human` pill means someone
 * promoted it; nothing on this page arrives because a model suggested it.
 */
function itemRow(app, i) {
  const promoted = i.id.startsWith("promoted:");
  return el("div", { class: "cp-blocker" }, [
    el("div", { class: "cp-row" }, [
      pill(i.severity, TONE[i.severity] || "neutral"),
      el("strong", { text: i.title }),
      pill(i.authority, i.authority === "human" ? "info" : "neutral"),
    ]),
    i.detail ? el("div", { class: "muted small", text: i.detail }) : null,
    el("div", { class: "cp-row" }, [
      i.link ? el("a", { class: "btn btn-sm", href: i.link, text: "Open" }) : null,
      promoted
        ? el("button", {
            class: "btn btn-sm",
            text: "Remove",
            onClick: async () => {
              await app.api.action("attention.dismiss", {
                id: i.id.slice("promoted:".length),
              });
              app.rerender();
            },
          })
        : null,
    ]),
    i.evidence?.length
      ? el("details", { class: "cp-why" }, [
          el("summary", { class: "small", text: "Why?" }),
          el(
            "ul",
            { class: "cp-reasons" },
            i.evidence.map((e) => el("li", { text: `${e.kind}: ${e.note}` })),
          ),
        ])
      : null,
  ]);
}

/** Minutes, rounded, or a dash: never a fabricated precision. */
function mins(ms) {
  return ms == null ? "·" : `${Math.round(ms / 60000)}m`;
}

/**
 * The Decision Ledger. Recording is a click, and the click is what makes the
 * record a human's - the form cannot ask for any other authority.
 */
function ledger(app) {
  const d = app.snapshot?.decisions || { total: 0, recent: [] };
  const text = el("input", {
    class: "input",
    type: "text",
    placeholder: "What was decided, in one line",
    maxlength: "300",
  });
  const why = el("input", {
    class: "input",
    type: "text",
    placeholder: "Why (optional)",
    maxlength: "1000",
  });

  return card("Decision ledger", [
    el("div", { class: "cp-row" }, [
      text,
      why,
      el("button", {
        class: "btn btn-sm",
        type: "button",
        text: "Record",
        onClick: async () => {
          if (!text.value.trim()) return app.toast("Say what was decided.");
          const r = await app.api.action("decision.record", {
            changeId: app.snapshot?.decisions?.changeId ?? undefined,
            decision: text.value.trim(),
            reason: why.value.trim() || undefined,
          });
          if (r?.ok === false) return app.toast(r.error, "danger");
          text.value = "";
          why.value = "";
          app.rerender();
        },
      }),
    ]),
    d.recent.length
      ? el(
          "div",
          { class: "cp-rows" },
          d.recent.map((x) =>
            el("div", { class: "cp-row" }, [
              pill(x.decidedBy, x.decidedBy === "human" ? "info" : "neutral"),
              el("span", { text: x.decision }),
              el("span", { class: "muted small", text: x.createdAt }),
            ]),
          ),
        )
      : el("div", {
          class: "muted small",
          text: "Nothing recorded for this change yet.",
        }),
  ]);
}

/** Lanes and waits: both are shown only where records support them. */
function workShape(app) {
  const t = app.snapshot?.tasks || {};
  const lanes = t.lanes;
  const waits = t.waits;
  if (!lanes?.lanes?.length && !waits?.measured && !waits?.openWaits)
    return null;

  return card("Work shape", [
    lanes?.lanes?.length
      ? el("div", {}, [
          el("div", { class: "cp-row" }, [
            pill(`${lanes.parallelism} lane(s)`, "neutral"),
            el("span", {
              class: "muted small",
              text: "tasks in one lane touch the same files, worktree or tests, so they go in sequence",
            }),
          ]),
          el(
            "ul",
            { class: "cp-reasons" },
            lanes.lanes.map((l) =>
              el("li", {
                text: `${l.id}: ${l.items.join(", ")}${
                  l.reasons.length ? ` — ${l.reasons[0]}` : ""
                }`,
              }),
            ),
          ),
          lanes.unpartitionable.length
            ? el("div", {
                class: "muted small",
                text: `${lanes.unpartitionable.length} task(s) changed nothing yet, so they are in no lane.`,
              })
            : null,
        ])
      : null,
    waits
      ? el("div", { class: "muted small" }, [
          el("span", {
            text: waits.measured
              ? `Median wait on a person: ${mins(waits.medianWaitMs)} across ${waits.closedWaits} recorded wait(s).`
              : "No completed waits recorded yet.",
          }),
          waits.openWaits
            ? el("span", { text: ` ${waits.openWaits} still waiting.` })
            : null,
        ])
      : null,
  ]);
}

/** Attention Inbox: what needs a person, not what blocks the merge. */
export function render(app) {
  const inbox = app.snapshot?.attentionInbox || { items: [], counts: null };
  const c = inbox.counts;

  const banner = el("div", { class: "cp-banner" }, [
    pill(
      c?.total ? `${c.total} needs you` : "clear",
      c?.blocking ? "danger" : c?.total ? "warn" : "ok",
    ),
    el("span", {
      class: "muted small",
      text: "Delivery blockers that need no judgement (uncommitted files, unpushed commits) live on the Readiness tab.",
    }),
  ]);

  const list = inbox.items.length
    ? el(
        "div",
        { class: "cp-rows" },
        inbox.items.map((i) => itemRow(app, i)),
      )
    : el("div", {
        class: "muted small",
        text: "Nothing is waiting on you. Items appear here when a provider reports a decision, a task asks for input or stops progressing, or you promote something yourself.",
      });

  const advisory = card(
    "Suggested attention",
    el("div", {}, [
      el("div", {
        class: "muted small",
        text: "Claude's assessments stay on the thread that produced them, in the Inbox. Use “Add to attention” there to bring one here; it is then recorded as your decision, not the model's.",
      }),
    ]),
  );

  return el(
    "div",
    { class: "view cp-view" },
    [
      banner,
      card(`Needs you (${c?.total ?? 0})`, list),
      workShape(app),
      ledger(app),
      advisory,
    ].filter(Boolean),
  );
}
