// @ts-check
/**
 * First-run setup wizard: a skippable overlay shown once on a fresh install
 * (server-tracked via snapshot.setup.firstRun), and re-openable any time from
 * Configuration. Any dismissal short of Finish records "skipped" so it never
 * auto-nags again. Token/preference writes reuse existing allowlisted actions.
 */
import { el, clear } from "./dom.mjs";

/**
 * Ordered steps. The forge is optional and pre-satisfied when a token is
 * already configured (env or settings.local.json), so an existing user skims
 * past it. Pure, so the step rail and the body share one source of truth.
 * @param {{ forgeConfigured?: boolean }} [ctx]
 */
export function deriveWizardModel(ctx = {}) {
  return [
    { id: "welcome", title: "Welcome" },
    {
      id: "forge",
      title: "Git forge",
      optional: true,
      satisfied: Boolean(ctx.forgeConfigured),
    },
    { id: "prefs", title: "Preferences" },
    { id: "finish", title: "Finish" },
  ];
}

/** @type {HTMLElement|null} */
let overlay = null;
let autoOpened = false;

/** Auto-open once per session, only on a genuine first run (server-tracked). */
export function maybeOpenWizard(app) {
  if (autoOpened || overlay) return;
  if (!app.snapshot?.setup?.firstRun) return;
  autoOpened = true;
  openWizard(app);
}

/** Open the wizard. Safe to call from Config after completion. */
export function openWizard(app) {
  if (overlay) return;
  const steps = deriveWizardModel({
    forgeConfigured: Boolean(app.snapshot?.forge?.configured),
  });
  let i = 0;
  let done = false;

  const title = el("h2", { class: "wizard-title", text: "Set up the panel" });
  const rail = el("div", { class: "wizard-rail", "aria-hidden": "true" });
  const body = el("div", { class: "wizard-body" });
  const backBtn = /** @type {HTMLButtonElement} */ (
    el("button", { class: "btn", text: "Back" })
  );
  const nextBtn = el("button", { class: "btn btn-primary", text: "Next" });
  const skipBtn = el("button", {
    class: "link-btn wizard-skip",
    text: "Skip setup",
  });

  function close() {
    if (!overlay) return;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    overlay = null;
  }

  async function finish() {
    if (done) return;
    done = true;
    try {
      await app.api.action("setup.complete");
    } catch {
      /* state is best-effort; the wizard still closes */
    }
    app.toast("Setup complete.", "ok");
    close();
  }

  async function skip() {
    if (done) return;
    done = true;
    try {
      await app.api.action("setup.skip");
    } catch {
      /* best-effort */
    }
    app.toast("Setup skipped. Re-run it any time from Configuration.", "info");
    close();
  }

  function paintRail() {
    clear(rail);
    steps.forEach((s, n) => {
      const cls =
        n === i
          ? "wizard-dot active"
          : n < i
            ? "wizard-dot done"
            : "wizard-dot";
      rail.append(el("span", { class: cls }));
    });
  }

  function paintFoot() {
    backBtn.disabled = i === 0;
    nextBtn.textContent = i === steps.length - 1 ? "Finish" : "Next";
  }

  function go(n) {
    i = Math.max(0, Math.min(steps.length - 1, n));
    title.textContent = stepTitle(steps[i]);
    clear(body).append(renderStep(app, steps[i]));
    paintRail();
    paintFoot();
    body.scrollTop = 0;
  }

  backBtn.addEventListener("click", () => go(i - 1));
  nextBtn.addEventListener("click", () => {
    if (i === steps.length - 1) finish();
    else go(i + 1);
  });
  skipBtn.addEventListener("click", skip);

  function onKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      skip();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (i === steps.length - 1) finish();
      else go(i + 1);
    }
  }

  const box = el("div", { class: "wizard-box", role: "document" }, [
    el("div", { class: "wizard-head" }, [title, rail, skipBtn]),
    body,
    el("div", { class: "wizard-foot" }, [
      backBtn,
      el("span", { class: "spacer" }),
      nextBtn,
    ]),
  ]);
  overlay = el(
    "div",
    {
      class: "cmd-overlay",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Panel setup",
      onMousedown: (e) => {
        if (e.target === overlay) skip();
      },
    },
    box,
  );
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);
  go(0);
  nextBtn.focus();
}

function stepTitle(step) {
  return (
    {
      welcome: "Welcome to Clawdeck",
      forge: "Connect your git forge (optional)",
      prefs: "Preferences",
      finish: "You're all set",
    }[step.id] || "Set up the panel"
  );
}

function renderStep(app, step) {
  switch (step.id) {
    case "welcome":
      return welcomeStep();
    case "forge":
      return forgeStep(app, step);
    case "prefs":
      return prefsStep(app);
    case "finish":
      return finishStep();
    default:
      return el("div");
  }
}

function lead(text) {
  return el("p", { class: "wizard-lead", text });
}

function welcomeStep() {
  return el("div", {}, [
    lead(
      "A local console for your worktrees, runs, reviews, and Claude sessions. " +
        "This quick setup is optional, everything here can also be changed later " +
        "in Configuration.",
    ),
    el("ul", { class: "wizard-list" }, [
      el("li", {
        text: "See every worktree's status, churn, and active Claude sessions.",
      }),
      el("li", {
        text: "Run validation, reviews, and review-pack jobs from one place.",
      }),
      el("li", {
        text: "Track merge requests and pipelines for the current branch on GitHub or GitLab.",
      }),
    ]),
  ]);
}

function forgeStep(app, step) {
  const wrap = el("div");
  if (step.satisfied) {
    wrap.append(
      el("div", { class: "wizard-ok" }, [
        el("span", { class: "pill pill-ok", text: "connected" }),
        el("span", {
          text: " A forge token is already configured. MR and pipeline status appear in the Review hub.",
        }),
      ]),
    );
    return wrap;
  }
  const provider = /** @type {HTMLSelectElement} */ (
    el("select", { class: "input" }, [
      el("option", { value: "gitlab", text: "GitLab" }),
      el("option", { value: "github", text: "GitHub" }),
    ])
  );
  const detected = app.snapshot?.forge?.provider;
  if (detected === "github") provider.value = "github";
  const token = /** @type {HTMLInputElement} */ (
    el("input", {
      class: "input",
      type: "password",
      autocomplete: "off",
      placeholder: "paste a personal access token",
    })
  );
  const save = /** @type {HTMLButtonElement} */ (
    el("button", { class: "btn btn-primary", text: "Save token" })
  );
  const status = el("span", { class: "wizard-inline muted small" });
  save.addEventListener("click", () => {
    const value = token.value.trim();
    if (!value) {
      app.toast("Enter a token, or skip this step.", "warn");
      return;
    }
    save.disabled = true;
    const param =
      provider.value === "github"
        ? { githubToken: value }
        : { gitlabToken: value };
    app.api
      .action("config.save", param)
      .then((res) => {
        if (res && res.ok) {
          step.satisfied = true;
          clear(status);
          status.append(el("span", { class: "pill pill-ok", text: "saved" }));
          app.toast("Forge token saved.", "ok");
          token.value = "";
        } else {
          app.toast(
            (res && res.error) || "Could not save the token.",
            "danger",
          );
          save.disabled = false;
        }
      })
      .catch((e) => {
        app.toast(String((e && e.message) || e), "danger");
        save.disabled = false;
      });
  });
  wrap.append(
    lead(
      "Add a personal access token for your git forge to see merge-request and " +
        "pipeline status, and get pipeline notifications. This is optional, you can skip it.",
    ),
    el("label", { class: "field" }, [
      el("span", { class: "field-label", text: "Provider" }),
      provider,
    ]),
    el("label", { class: "field" }, [
      el("span", { class: "field-label", text: "Token (write-only)" }),
      token,
      el("span", {
        class: "field-hint",
        text: "Stored server-side in settings.local.json, never sent back to the browser.",
      }),
    ]),
    el("div", { class: "btn-row" }, [save, status]),
  );
  return wrap;
}

function prefsStep(app) {
  const theme = /** @type {HTMLSelectElement} */ (
    el(
      "select",
      {
        class: "input",
        onChange: (e) => {
          app.config.theme = e.target.value;
          app.applyConfig();
        },
      },
      ["system", "light", "dark"].map((o) =>
        el("option", {
          value: o,
          selected: o === app.config.theme ? true : null,
          text: o,
        }),
      ),
    )
  );
  return el("div", {}, [
    lead("Pick how the panel looks and whether it can notify you."),
    el("label", { class: "field" }, [
      el("span", { class: "field-label", text: "Theme" }),
      theme,
      el("span", {
        class: "field-hint",
        text: "System follows your OS preference.",
      }),
    ]),
    notifyRow(app),
  ]);
}

/** Desktop-notification opt-in; enabling it requests browser permission first. */
function notifyRow(app) {
  const supported = typeof Notification !== "undefined";
  const on = Boolean(app.config.desktopNotifications) && supported;
  const sw = el("button", {
    class: `switch ${on ? "on" : ""}`,
    role: "switch",
    type: "button",
    "aria-checked": String(on),
    "aria-label": "Desktop notifications",
    disabled: supported ? null : true,
  });
  const apply = (next) => {
    sw.classList.toggle("on", next);
    sw.setAttribute("aria-checked", String(next));
    app.config.desktopNotifications = next;
    app.applyConfig();
  };
  sw.addEventListener("click", async () => {
    if (!supported) return app.toast("Notifications unsupported here.", "warn");
    const next = !sw.classList.contains("on");
    if (!next) return apply(false);
    if (Notification.permission === "granted") return apply(true);
    const perm = await Notification.requestPermission();
    if (perm === "granted") apply(true);
    else app.toast("Notification permission denied by the browser.", "warn");
  });
  return el("div", { class: "setting-row" }, [
    el("div", {}, [
      el("strong", { text: "Desktop notifications" }),
      el("p", {
        class: "muted small",
        text: supported
          ? "Notify when an agent goes active or a job finishes (needs permission)."
          : "This browser context does not support notifications.",
      }),
    ]),
    sw,
  ]);
}

const SHORTCUTS = [
  ["⌘ / Ctrl + K", "Command palette"],
  ["1 - 8", "Switch hubs"],
  ["[ / ]", "Previous / next tab"],
  ["r", "Refresh now"],
  ["t", "Toggle theme"],
  ["?", "Keyboard shortcuts"],
];

function finishStep() {
  return el("div", {}, [
    lead(
      "That's it. Explore the hubs from the sidebar, and use these shortcuts to " +
        "move fast.",
    ),
    el(
      "dl",
      { class: "wizard-keys" },
      SHORTCUTS.flatMap(([k, d]) => [
        el("dt", {}, el("kbd", { text: k })),
        el("dd", { text: d }),
      ]),
    ),
  ]);
}
