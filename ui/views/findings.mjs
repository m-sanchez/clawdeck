// @ts-check
import { el, card, pill, emptyState } from "../lib/dom.mjs";
import { buildClaudeCommand } from "../lib/open-in-claude.mjs";

const SEV_TONE = { block: "danger", warn: "warn", info: "neutral" };
const STATE_TONE = {
  found: "neutral",
  "needs-verification": "warn",
  confirmed: "warn",
  rejected: "neutral",
  "fix-dispatched": "info",
  changed: "info",
  "targeted-test-passed": "ok",
  "reverify-required": "warn",
  resolved: "ok",
};

async function copyText(app, text) {
  try {
    await navigator.clipboard.writeText(text);
    app.toast?.("Copied to clipboard.", "ok");
  } catch {
    app.toast?.("Clipboard unavailable.", "warn");
  }
}

async function transition(app, findingId, to, reason) {
  try {
    const r = await app.api.action("findings.transition", {
      findingId,
      to,
      ...(reason ? { reason } : {}),
    });
    if (r.ok === false) app.toast?.(r.error || "Transition refused.", "err");
    else app.toast?.(`Finding → ${r.state}.`, "ok");
  } catch (err) {
    app.toast?.(String((err && err.message) || err), "err");
  }
}

/** Dispatch the fix by opening Claude (plan mode) in the checkout via a
 *  claude-cli:// deep link: the prompt is prefilled, NOT auto-submitted. A
 *  browser cannot confirm the OS opened the link, so the label never claims a
 *  session started and the finding is NOT auto-advanced, the user advances it
 *  from the Fix Station once the fix actually begins. */
async function dispatchFix(app, fixPrompt, worktreePath) {
  try {
    const r = await app.api.action("claude.open", {
      worktreePath,
      prompt: fixPrompt,
    });
    if (r.ok && r.url) {
      const a = document.createElement("a");
      a.href = r.url;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      app.toast?.(
        r.truncated
          ? "Opening Claude, the prompt was truncated for the link; use Copy prompt for the full fix."
          : "Opening Claude, if nothing opens, use Copy prompt. Advance the finding from the Fix Station once the fix starts.",
        r.truncated ? "warn" : "ok",
      );
    } else if (r.refused) {
      // Secret detected in the prompt: do NOT auto-copy it. Remove the secret
      // and retry, or use Copy prompt explicitly.
      app.toast?.(r.reason || "Refused to build a Claude link.", "warn");
    } else {
      const cmd = buildClaudeCommand({ permissionMode: "plan" });
      await copyText(
        app,
        `${fixPrompt}\n\n--- run in checkout ---\n${cmd.display}`,
      );
      app.toast?.(
        r.reason ||
          r.error ||
          "Could not build the Claude link, copied instead.",
        "warn",
      );
    }
  } catch (err) {
    app.toast?.(String((err && err.message) || err), "err");
  }
}

function findingCard(app, f, root, worktreePath) {
  const sev = f.severity || (f.blocking ? "block" : "warn");
  const loc = `${f.file || "?"}${f.line ? `:${f.line}` : ""}`;
  const rule = f.ruleId || f.rule || "?";
  const state = f.lifecycle?.state || "found";
  const fixPrompt =
    `Fix this review finding:\n- ${sev} ${rule} at ${loc}\n- ${f.title || f.message || ""}` +
    `\n\nOpen the file, confirm the issue is real, then fix it minimally. Do not expand scope.`;

  // Lifecycle-appropriate actions only (the server enforces the legal graph).
  const actions = [];
  if (state === "found" || state === "needs-verification") {
    actions.push(
      el("button", {
        class: "btn",
        text: "Confirm",
        onClick: () => transition(app, f.findingId, "confirmed"),
      }),
      el("button", {
        class: "btn",
        text: "Reject",
        onClick: () =>
          transition(app, f.findingId, "rejected", "not a real issue"),
      }),
    );
  }
  if (state === "confirmed" || state === "reverify-required") {
    actions.push(
      el("button", {
        class: "btn btn-primary",
        text: "Dispatch fix",
        onClick: () => dispatchFix(app, fixPrompt, worktreePath),
      }),
    );
  }
  if (state === "changed") {
    actions.push(
      el("button", {
        class: "btn",
        text: "Targeted test passed",
        onClick: () => transition(app, f.findingId, "targeted-test-passed"),
      }),
      el("button", {
        class: "btn",
        text: "Re-verify",
        onClick: () => transition(app, f.findingId, "reverify-required"),
      }),
    );
  }
  if (state === "targeted-test-passed") {
    actions.push(
      el("button", {
        class: "btn btn-primary",
        text: "Resolve",
        onClick: () => transition(app, f.findingId, "resolved"),
      }),
    );
  }
  if (state === "rejected") {
    actions.push(
      el("button", {
        class: "btn",
        text: "Reopen",
        onClick: () => transition(app, f.findingId, "found"),
      }),
    );
  }
  actions.push(
    el("button", {
      class: "btn",
      text: "Copy fix prompt",
      onClick: () => copyText(app, fixPrompt),
    }),
  );

  return card(`${String(sev).toUpperCase()} · ${loc}`, [
    el("div", { class: "cp-row" }, [
      pill(sev, SEV_TONE[sev] || "neutral"),
      pill(state, STATE_TONE[state] || "neutral"),
      f.lifecycle && f.lifecycle.present === false
        ? pill("not in last scan", "info")
        : null,
      el("code", { class: "mono small", text: rule }),
    ]),
    el("div", { text: f.title || f.message || "(no description)" }),
    f.detail ? el("div", { class: "muted small", text: f.detail }) : null,
    f.lifecycle?.fixSession
      ? el("div", {
          class: "muted small",
          text: `fix session ${f.lifecycle.fixSession}`,
        })
      : null,
    el("div", { class: "muted small", text: `id ${f.findingId || "?"}` }),
    el("div", { class: "btn-row" }, actions),
  ]);
}

/** Fix Station: review findings as tracked objects with a scoped fix action. */
export function render(app) {
  const s = app.snapshot || {};
  const findings = s.findings || [];
  const root = s.checkout?.root || ".";
  const worktreePath = s.checkout?.root || null;
  // A resolved finding is done; keep it out of the active queue unless reopened.
  const active = findings.filter((f) => f.lifecycle?.state !== "resolved");
  if (!active.length)
    return el("div", { class: "view cp-view" }, [
      card("Fix Station", [
        emptyState(
          "No open findings.",
          "Review findings appear here as tracked objects, each with a durable lifecycle and a scoped fix action.",
        ),
      ]),
    ]);
  return el(
    "div",
    { class: "view cp-view" },
    active.map((f) =>
      el("div", { class: "cp-finding" }, [
        findingCard(app, f, root, worktreePath),
      ]),
    ),
  );
}
