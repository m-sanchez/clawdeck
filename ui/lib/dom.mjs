// @ts-check
/** Tiny DOM helpers. No framework: build nodes, never set innerHTML on data. */

/**
 * Create an element. Children may be nodes or strings (auto text nodes). Attrs:
 * className, dataset, on* event handlers, aria-*, or plain attributes.
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {Array<Node|string|null|undefined>|Node|string} [children]
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class" || key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html")
      node.innerHTML = value; // only ever called with trusted literals
    else if (key === "dataset")
      for (const [d, v] of Object.entries(value)) node.dataset[d] = v;
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null) continue;
    node.append(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Relative time like "3m ago" from an ISO string / epoch. */
export function relTime(value) {
  if (!value) return "·";
  const t = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(t)) return "·";
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  /** @type {[number, string][]} */
  const units = [
    [86400000, "d"],
    [3600000, "h"],
    [60000, "m"],
    [1000, "s"],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      // diff = now - t, so a past timestamp is positive ("ago"), future is "in".
      const n = Math.round(diff / ms);
      return n >= 0 ? `${n}${label} ago` : `in ${-n}${label}`;
    }
  }
  return "just now";
}

export function absTime(value) {
  if (!value) return "·";
  const t = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(t)) return "·";
  return new Date(t).toLocaleString();
}

/** A coloured status pill element. */
export function pill(label, tone = "neutral") {
  return el("span", { class: `pill pill-${tone}`, text: String(label) });
}

const STATUS_TONE = {
  running: "info",
  waiting: "warn",
  blocked: "danger",
  failed: "danger",
  passed: "ok",
  stopped: "neutral",
  completed: "ok",
  ok: "ok",
  stale: "warn",
  pending: "neutral",
};
export function statusTone(status) {
  return STATUS_TONE[status] || "neutral";
}

/** A labelled section card. `opts.help` adds a "?" tooltip next to the title. */
export function card(title, body, opts = {}) {
  const head = el("div", { class: "card-head" }, [
    el("div", { class: "card-title-row" }, [
      el("h2", { class: "card-title" }, title),
      opts.help ? helpIcon(opts.help) : null,
    ]),
    opts.aside || null,
  ]);
  return el("section", { class: `card ${opts.class || ""}` }, [
    head,
    el("div", { class: "card-body" }, body),
  ]);
}

/** Empty-state placeholder. */
export function emptyState(message, hint) {
  return el("div", { class: "empty" }, [
    el("div", { class: "empty-mark", text: "◦" }),
    el("p", { class: "empty-msg", text: message }),
    hint ? el("p", { class: "empty-hint", text: hint }) : null,
  ]);
}

/**
 * A split button: the visible chip runs the first (default, non-destructive)
 * action; a caret opens a menu of all actions. Keeps a copy action as the default
 * while exposing real execute actions behind the caret.
 * @param {{ label: string, onClick: () => void, danger?: boolean }[]} items first = default
 * @param {{ label?: string, class?: string }} [opts]
 */
export function actionMenu(items, opts = {}) {
  const list = el(
    "div",
    { class: "action-menu-list", hidden: true, role: "menu" },
    items.map((it) =>
      el("button", {
        class: `action-item ${it.danger ? "danger" : ""}`,
        role: "menuitem",
        text: it.label,
        onClick: () => {
          close();
          it.onClick();
        },
      }),
    ),
  );
  function close() {
    list.hidden = true;
    document.removeEventListener("click", onDoc, true);
  }
  function onDoc(e) {
    if (!menu.contains(/** @type {Node} */ (e.target))) close();
  }
  const caret = el("button", {
    class: "action-caret",
    "aria-label": "More actions",
    text: "▾",
    onClick: (e) => {
      e.stopPropagation();
      if (list.hidden) {
        list.hidden = false;
        document.addEventListener("click", onDoc, true);
      } else close();
    },
  });
  const primary = el("button", {
    class: `chip action-primary ${opts.class || ""}`,
    text: opts.label || items[0].label,
    onClick: () => items[0].onClick(),
  });
  const menu = el("span", { class: "action-menu" }, [primary, caret, list]);
  return menu;
}

/** A small "?" help marker with a hover/focus tooltip explaining a label. */
export function helpIcon(text) {
  return el(
    "span",
    {
      class: "help-icon",
      tabindex: "0",
      role: "img",
      "data-tip": text,
      "aria-label": `Help: ${text}`,
    },
    "?",
  );
}

/** A "Run in / Scope" worktree selector: Current checkout + each worktree. */
export function worktreeSelect(app, value, onChange) {
  const wts = app.snapshot?.worktrees ?? [];
  return el(
    "select",
    {
      class: "input",
      name: "scope-worktree",
      "aria-label": "Scope",
      onChange: (e) => onChange(e.target.value),
    },
    [
      el("option", {
        value: "",
        selected: value === "" ? true : null,
        text: "Current checkout",
      }),
      ...wts.map((w) =>
        el("option", {
          value: w.path,
          selected: w.path === value ? true : null,
          text: `${w.branch}${w.isCurrent ? " (this)" : ""}`,
        }),
      ),
    ],
  );
}
