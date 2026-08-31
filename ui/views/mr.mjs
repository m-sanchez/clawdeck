// @ts-check
/**
 * Merge-request composer: assembles a suggested title + plain-prose description
 * from the branch's commits and diff totals, then lets you copy them and open
 * the forge's new-MR page (source/target params only, so no description ever rides
 * the URL). The panel never creates or edits the MR; the user submits it.
 */
import { el, card, clear } from "../lib/dom.mjs";

export function render(app) {
  const source = inp(
    "select",
    { class: "input", "data-tip": "Source branch (the one being merged in)." },
    [
      el("option", {
        value: app.store.mrSource || "",
        text: app.store.mrSource || "current branch",
      }),
    ],
  );
  const target = inp(
    "select",
    { class: "input", "data-tip": "Target branch for the merge request." },
    [
      el("option", {
        value: app.store.mrTarget || "develop",
        text: app.store.mrTarget || "develop",
      }),
    ],
  );
  const host = el("div", { class: "mr-host" });

  const load = () => {
    app.store.mrSource = source.value;
    app.store.mrTarget = target.value.trim() || "develop";
    clear(host).append(
      el("div", { class: "df-running" }, [
        el("span", { class: "spinner-inline" }),
        el("span", { class: "muted small", text: "Reading branch…" }),
      ]),
    );
    app.api
      .mrDraft(app.store.mrTarget, app.store.mrSource || undefined)
      .then((d) => renderDraft(app, host, d))
      .catch((e) => clear(host).append(errBox(String((e && e.message) || e))));
  };
  source.addEventListener("change", load);
  target.addEventListener("change", load);
  load();

  // Populate both dropdowns from the local branch list.
  app.api
    .branches()
    .then((r) => {
      const list = (r && r.branches) || [];
      if (!list.length) return;
      fillBranchSelect(source, list, app.store.mrSource || r.current);
      fillBranchSelect(target, list, app.store.mrTarget || "develop");
    })
    .catch(() => {});

  return el("div", { class: "view view-mr" }, [
    card("Merge request", [
      el("p", {
        class: "muted small",
        text: "Compose a title and description from a branch, then open your git forge to submit. Nothing is created or pushed from here.",
      }),
      el("div", { class: "console-form" }, [
        field("Source", source),
        field("Target", target),
      ]),
      host,
    ]),
  ]);
}

function fillBranchSelect(select, branches, selected) {
  clear(select);
  for (const b of branches) select.append(el("option", { value: b, text: b }));
  if (branches.includes(selected)) select.value = selected;
}

function renderDraft(app, host, d) {
  clear(host);
  if (!d.commits || !d.commits.length) {
    host.append(
      el("p", {
        class: "muted small",
        text: `No commits on ${d.branch || "this branch"} vs ${d.base || d.target}.`,
      }),
    );
    return;
  }
  const titleVal = cleanSubject(d.commits[0].subject) || d.branch || "";
  const n = d.commits.length;
  const plural = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const stats =
    `${plural(n, "commit")}, ${plural(d.totalFiles, "file")} changed ` +
    `(+${(d.totalAdded || 0).toLocaleString()} / -${(d.totalRemoved || 0).toLocaleString()}) ` +
    `vs \`${d.target}\`.`;
  const bullets = d.commits
    .map((c) => `- ${cleanSubject(c.subject)}`)
    .join("\n");
  const descVal = `## Summary\n\n${stats}\n\n## Changes\n\n${bullets}\n`;

  const title = inp("input", { class: "input", value: titleVal });
  const desc = inp("textarea", { class: "input mr-desc mono", rows: "14" });
  desc.value = descVal;

  host.append(
    el("div", { class: "mr-summary small muted" }, [
      el("span", { text: `${d.branch} → ${d.target}` }),
      el("span", { text: `${d.commits.length} commits` }),
      el("span", {
        text: `${d.totalFiles} files · +${d.totalAdded} / -${d.totalRemoved}`,
      }),
      el("span", { text: `base ${d.base}` }),
    ]),
    field("Title", title),
    field("Description", desc),
    el("div", { class: "btn-row" }, [
      el("a", {
        class: "btn btn-primary",
        href: d.newMrUrl,
        target: "_blank",
        rel: "noopener",
        text: "Open new MR on the forge",
      }),
      el("button", {
        class: "btn",
        text: "Copy title",
        onClick: () => copy(app, title.value),
      }),
      el("button", {
        class: "btn",
        text: "Copy description",
        onClick: () => copy(app, desc.value),
      }),
    ]),
    el("p", {
      class: "muted small",
      text: "Tip: open the MR, then paste the description (forges reject long descriptions passed via the URL).",
    }),
  );
}

/** Drop a leading "PROJ-1234 Scope - " ticket prefix for a cleaner bullet. */
function cleanSubject(s) {
  return String(s || "")
    .replace(/^[A-Z][A-Z0-9]+-\d+\s+\S+\s+-\s+/, "")
    .trim();
}

function field(label, node) {
  return el("label", { class: "field" }, [
    el("span", { class: "field-label", text: label }),
    node,
  ]);
}

function errBox(msg) {
  return el("div", { class: "inspector-error" }, [
    el("strong", { text: "Error" }),
    el("div", { class: "muted small", text: msg }),
  ]);
}

function inp(tag, attrs, children) {
  return /** @type {HTMLInputElement & HTMLTextAreaElement} */ (
    el(tag, attrs, children)
  );
}

async function copy(app, text) {
  try {
    await navigator.clipboard.writeText(text);
    app.toast("Copied.", "ok");
  } catch {
    app.toast("Clipboard unavailable.", "warn");
  }
}
