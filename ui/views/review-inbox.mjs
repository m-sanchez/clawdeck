// @ts-check
/**
 * Review Inbox: the remote review threads on this branch's change, mapped to
 * local code.
 *
 * Three visual grammars, deliberately unalike. Provider and git facts are plain
 * text. Anything Clawdeck derived is a pill with a "Why?" disclosure listing the
 * evidence it was computed from. Anything Claude said sits in its own indented
 * block labelled advisory. Nothing here writes to the forge.
 *
 * The view is not `auto`: it holds input (filters, expanded threads, in-flight
 * assists), so a snapshot must never re-render it out from under the reader. It
 * fetches its own data and offers a refresh when newer data lands.
 */
import { el, card, pill, clear, emptyState, forgeLabel } from "../lib/dom.mjs";
import {
  filterCounts,
  filterItems,
  groupByFile,
  threadRows,
} from "../shared/review-inbox-model.mjs";

const FILTERS = [
  ["unresolved", "Unresolved"],
  ["blocking", "Blocking"],
  ["changed", "Code changed"],
  ["unknown", "Unknown"],
  ["all", "All"],
];

export function render(app) {
  const store = app.store;
  if (!store.inboxFilter) store.inboxFilter = "unresolved";
  if (!store.inboxAssists) store.inboxAssists = {};
  if (!store.inboxOpen) store.inboxOpen = new Set();
  if (!store.inboxDraftOpen) store.inboxDraftOpen = new Set();
  if (!store.inboxDrafts) store.inboxDrafts = {};

  const host = el("div", { class: "view cp-view" });
  const body = el("div", {});
  host.append(body);

  const load = (force) => {
    clear(body).append(
      el("div", { class: "running-note" }, [
        el("span", { class: "spinner" }),
        el("span", { text: " Reading review threads…" }),
      ]),
    );
    app.api
      .reviewInbox(force)
      .then((data) => {
        store.inboxData = data;
        store.inboxSeenHash =
          app.snapshot?.sections?.byKey?.reviewInbox ?? null;
        renderInbox(app, body, data, load);
      })
      .catch((err) => {
        clear(body).append(
          card("Review inbox", [
            emptyState(
              "Could not read the review inbox.",
              String(err?.message || err),
            ),
          ]),
        );
      });
  };

  if (store.inboxData) renderInbox(app, body, store.inboxData, load);
  else load(false);
  return host;
}

function renderInbox(app, host, data, reload) {
  clear(host);

  if (!data || data.available !== true) {
    host.append(unavailableCard(app, data, reload));
    return;
  }

  const items = data.items || [];
  const counts = filterCounts(items);
  const shown = filterItems(items, app.store.inboxFilter);

  host.append(banner(app, data, reload));
  host.append(kpis(data, counts));
  host.append(filterRow(app, counts));

  if (!shown.length) {
    host.append(
      card("Threads", [
        emptyState(
          "No threads match this filter.",
          data.coverage?.threads?.complete === false
            ? "Some threads were not read: the listing was cut short."
            : "Try the All filter.",
        ),
      ]),
    );
    return;
  }

  const groups = groupByFile(shown);
  const list = el("div", { class: "ri-groups" });
  for (const group of groups) {
    const details = el("details", { class: "finding-group", open: "" });
    details.append(
      el("summary", {}, [
        el("span", { class: "mono", text: group.file }),
        el("span", {
          class: "muted small",
          text: ` ${group.items.length} thread(s)`,
        }),
        group.changed ? pill("file changed since review", "info") : null,
      ]),
    );
    const ul = el("ul", { class: "ri-list" });
    for (const item of group.items) ul.append(threadRow(app, item, reload));
    details.append(ul);
    list.append(details);
  }
  host.append(card("Review threads", [list]));

  if (data.noteCount)
    host.append(
      card("Conversation comments", [
        el("p", {
          class: "muted small",
          text: `${data.noteCount} general comment(s) on this change. These carry no resolution state, so they never block delivery.`,
        }),
      ]),
    );
}

function banner(app, data, reload) {
  const { name, ref } = forgeLabel(data.provider);
  const parts = [
    pill(name, "neutral"),
    el("span", { class: "mono", text: `${ref}${data.mrIid}` }),
    el("span", {
      class: "muted small",
      text: `read ${data.observedAt ? new Date(data.observedAt).toLocaleTimeString() : "never"}`,
    }),
  ];
  if (data.freshness === "stale")
    parts.push(pill("stale — provider unavailable", "warn"));
  if (data.coverage?.threads?.complete === false)
    parts.push(
      pill(`partial: ${data.coverage.threads.reason || "cut short"}`, "warn"),
    );
  if (data.coverage?.resolution?.complete === false)
    parts.push(pill("resolution not fully read", "warn"));
  for (const d of data.degraded || []) parts.push(pill(d, "neutral"));
  parts.push(
    el("button", {
      class: "btn btn-sm",
      text: "Refresh",
      onClick: () => reload(true),
    }),
  );
  return el("div", { class: "cp-banner" }, parts);
}

function kpis(data, counts) {
  const c = data.counts || {};
  const kpi = (label, value, detail, tone) =>
    el("div", { class: `kpi-card ${tone ? `kpi-${tone}` : ""}` }, [
      el("div", { class: "kpi-label", text: label }),
      el("div", { class: "kpi-value", text: String(value) }),
      el("div", { class: "muted small", text: detail }),
    ]);
  return el("div", { class: "kpi-row" }, [
    kpi(
      "Unresolved",
      c.remoteUnresolved ?? 0,
      "reported by the provider",
      c.remoteUnresolved ? "warn" : null,
    ),
    kpi("Resolution unknown", c.resolutionUnknown ?? 0, "provider did not say"),
    kpi("Code changed", counts.changed ?? 0, "since the review"),
    kpi(
      "Needs you",
      (c.needsHuman ?? 0) + (c.replyDrafted ?? 0),
      "marked or drafted",
    ),
  ]);
}

function filterRow(app, counts) {
  return el(
    "div",
    { class: "ri-filters" },
    FILTERS.map(([key, label]) =>
      el("button", {
        class: `chip ${app.store.inboxFilter === key ? "chip-active" : ""}`,
        type: "button",
        text: `${label} (${counts[key] ?? 0})`,
        onClick: () => {
          app.store.inboxFilter = key;
          app.rerender();
        },
      }),
    ),
  );
}

function threadRow(app, item, reload) {
  const id = item.thread.id;
  const assist = app.store.inboxAssists[id] || null;
  const rows = threadRows(item, assist?.status === "done" ? assist : null);
  const li = el("li", { class: "ri-thread" });

  const head = el("div", { class: "ri-head" }, [
    el("span", { class: "mono small", text: item.thread.author || "unknown" }),
    el("span", {
      class: "mono small muted",
      text: item.thread.location?.file
        ? `${item.thread.location.file}:${item.thread.location.line ?? "?"}`
        : "no anchor",
    }),
    derivedPill(rows),
    remoteText(rows),
  ]);
  li.append(head);

  const first = item.thread.comments?.[0];
  if (first)
    li.append(el("p", { class: "ri-body", text: truncate(first.body, 400) }));

  li.append(whyBlock(rows));
  li.append(actions(app, item, assist, reload));
  if (assist) li.append(assistBlock(assist));
  li.append(draftEditor(app, item, assist, reload));
  return li;
}

/** The one derived row that names the state, as a pill with its tone. */
function derivedPill(rows) {
  const state = rows.find((r) => r.tier === "derived" && r.key === "state");
  if (!state) return null;
  return pill(
    state.certainty === "likely" ? `${state.label} (likely)` : state.label,
    state.tone || "neutral",
  );
}

/** Provider truth as plain text: no pill, so it never reads as a derivation. */
function remoteText(rows) {
  const remote = rows.find((r) => r.key === "remote");
  return el("span", {
    class: "muted small",
    text: remote ? `remote: ${remote.value}` : "",
  });
}

function whyBlock(rows) {
  const derived = rows.filter((r) => r.tier === "derived");
  if (!derived.length) return null;
  const details = el("details", { class: "ri-why" });
  details.append(el("summary", { class: "small", text: "Why?" }));
  const ul = el("ul", { class: "ri-evidence" });
  for (const row of derived)
    for (const e of row.evidence || [])
      ul.append(
        el("li", { class: "small" }, [
          el("span", { class: "mono small muted", text: `${e.kind} ` }),
          el("span", { text: e.note }),
          e.ref ? el("code", { class: "mono small", text: ` ${e.ref}` }) : null,
        ]),
      );
  details.append(ul);
  return details;
}

function actions(app, item, assist, reload) {
  const id = item.thread.id;
  const busy = assist?.status === "running";
  const btn = (kind, label) =>
    el("button", {
      class: "btn btn-sm",
      type: "button",
      text: label,
      disabled: busy ? true : null,
      onClick: () => runAssist(app, item, kind),
    });

  const row = el("div", { class: "btn-row" }, [
    btn("explain", "Explain"),
    btn("investigate", "Investigate"),
    btn("draft-reply", "Draft reply"),
    btn("draft-pushback", "Draft pushback"),
    el("button", {
      class: "btn btn-sm",
      type: "button",
      text: item.local?.draftChars ? "Edit draft" : "Write reply",
      onClick: () => {
        if (!app.store.inboxDraftOpen) app.store.inboxDraftOpen = new Set();
        app.store.inboxDraftOpen.add(id);
        app.rerender();
      },
    }),
    el("button", {
      class: "btn btn-sm",
      type: "button",
      text: item.local?.mark === "needs-human" ? "Unmark" : "Needs me",
      onClick: async () => {
        await app.api.action("reviewInbox.mark", {
          id,
          mark: item.local?.mark === "needs-human" ? "none" : "needs-human",
        });
        reload(false);
      },
    }),
  ]);
  if (item.thread.remoteUrl)
    row.append(
      el("a", {
        class: "btn btn-sm",
        href: item.thread.remoteUrl,
        target: "_blank",
        rel: "noopener",
        text: "Open remote ↗",
      }),
    );
  if (busy)
    row.append(
      el("button", {
        class: "btn btn-sm",
        type: "button",
        text: "Cancel",
        onClick: () => cancelAssist(app, id),
      }),
    );
  return row;
}

/** Model output: indented, labelled, and never styled like a fact or a pill. */
function assistBlock(assist) {
  const block = el("div", { class: "assist-out" });
  block.append(
    el("div", { class: "assist-head" }, [
      pill("Claude", "warn"),
      el("span", {
        class: "muted small",
        text: `${assist.kind} — advisory, unverified`,
      }),
    ]),
  );
  if (assist.status === "running")
    block.append(el("p", { class: "muted small", text: "Thinking…" }));
  else if (assist.status === "refused")
    block.append(
      el("p", {
        class: "small",
        text: `Refused: ${assist.reason}${
          assist.patterns?.length ? ` (${assist.patterns.join(", ")})` : ""
        }`,
      }),
    );
  else if (assist.status === "error")
    block.append(el("p", { class: "small", text: assist.error }));
  else if (assist.answer) {
    block.append(el("p", { class: "assist-text", text: assist.answer }));
    block.append(
      el("div", { class: "muted small" }, [
        el("span", {
          text: `sent ${assist.contextChars ?? 0} characters of context; nothing was posted to the provider`,
        }),
      ]),
    );
  }
  return block;
}

/**
 * Editing and saving a reply. Saving is a human act, and it is what moves a
 * thread to REPLY_DRAFTED - the model's text only ever pre-fills the box.
 * Nothing here reaches the provider; copying is how a reply gets posted.
 */
function draftEditor(app, item, assist, reload) {
  const id = item.thread.id;
  const suggested =
    assist?.status === "done" && /^draft-/.test(assist.kind)
      ? assist.answer
      : "";
  const existing = app.store.inboxDrafts?.[id];
  const open = app.store.inboxDraftOpen?.has(id);
  if (!open && !item.local?.draftChars && !suggested) return null;

  const box = el("textarea", {
    class: "input mono ri-draft",
    rows: "5",
    placeholder: "Your reply. Saved locally; Clawdeck never posts it.",
  });
  box.value = existing ?? suggested ?? "";

  const status = el("span", {
    class: "muted small",
    text: item.local?.draftChars
      ? `${item.local.draftChars} characters saved locally · not posted`
      : "not saved yet",
  });

  const save = async (body) => {
    const r = await app.api.action("reviewInbox.draft", { id, body });
    if (r?.ok === false) {
      app.toast(r.error, "danger");
      return;
    }
    app.store.inboxDrafts = { ...(app.store.inboxDrafts || {}), [id]: body };
    app.toast(body ? "Draft saved locally." : "Draft cleared.", "ok");
    reload(false);
  };

  return el("div", { class: "ri-draft-wrap" }, [
    box,
    el("div", { class: "btn-row" }, [
      el("button", {
        class: "btn btn-sm btn-primary",
        type: "button",
        text: "Save draft",
        onClick: () => save(box.value),
      }),
      el("button", {
        class: "btn btn-sm",
        type: "button",
        text: "Copy",
        onClick: () => {
          navigator.clipboard?.writeText(box.value);
          app.toast("Copied. Paste it into the review to post it.", "info");
        },
      }),
      item.local?.draftChars
        ? el("button", {
            class: "btn btn-sm",
            type: "button",
            text: "Clear",
            onClick: () => save(""),
          })
        : null,
      status,
    ]),
  ]);
}

async function runAssist(app, item, kind) {
  const id = item.thread.id;
  const controller = new AbortController();
  app.store.inboxAssists[id] = { kind, status: "running", controller };
  app.rerender();
  try {
    const r = await app.api.action(
      "reviewInbox.assist",
      { id, kind },
      { signal: controller.signal },
    );
    if (r?.refused)
      app.store.inboxAssists[id] = {
        kind,
        status: "refused",
        reason: r.reason,
        patterns: r.patterns,
      };
    else if (r?.ok)
      app.store.inboxAssists[id] = {
        kind,
        status: "done",
        answer: r.answer,
        contextChars: r.contextChars,
      };
    else
      app.store.inboxAssists[id] = {
        kind,
        status: "error",
        error: r?.error || "the assist failed",
      };
  } catch (err) {
    app.store.inboxAssists[id] = {
      kind,
      status: "error",
      error: String(err?.message || err),
    };
  }
  app.rerender();
}

function cancelAssist(app, id) {
  const assist = app.store.inboxAssists[id];
  assist?.controller?.abort();
  app.api.action("reviewInbox.assist.cancel", { id }).catch(() => {});
  delete app.store.inboxAssists[id];
  app.rerender();
}

function unavailableCard(app, data, reload) {
  const reason = data?.reason || "unavailable";
  const copy = {
    disabled: [
      "The review inbox is turned off.",
      "Set reviewInbox to true in the checkout's .claude/settings.local.json to turn it back on. While off, nothing is fetched.",
    ],
    "no-remote": [
      "No git forge detected for this checkout.",
      "Clawdeck reads the origin remote to decide which provider to ask.",
    ],
    "no-token": [
      "A provider token is required to read review threads.",
      "Add it in Configuration; it stays server-side.",
    ],
    unsupported: [
      "Review threads are not supported for this provider yet.",
      "GitHub and GitLab are implemented. MR and pipeline status still work on Readiness.",
    ],
    "no-change": [
      "No open pull or merge request for this branch.",
      "Open one from Review → Merge Request, then this fills in.",
    ],
    "fetch-failed": [
      "Could not read review threads.",
      data?.detail || "The provider did not answer.",
    ],
  }[reason] || ["Review threads are unavailable.", data?.detail || ""];

  return card("Review inbox", [
    emptyState(copy[0], copy[1]),
    el("div", { class: "btn-row" }, [
      el("button", {
        class: "btn btn-sm",
        text: "Retry",
        onClick: () => reload(true),
      }),
    ]),
  ]);
}

function truncate(text, max) {
  const t = String(text || "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
