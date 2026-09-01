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

  return el("div", { class: "view cp-view" }, [
    banner,
    card(`Needs you (${c?.total ?? 0})`, list),
    advisory,
  ]);
}
