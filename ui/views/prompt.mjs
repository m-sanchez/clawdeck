// @ts-check
/**
 * Context-loaded prompt composer: write a task, tick the panel facts to attach
 * (branch, push-readiness, review findings, failing validation, attention queue,
 * recent commits), and copy one ready-to-paste prompt for a Claude session. Pure
 * read of the snapshot; assembles plain text only.
 */
import { el, card, clear, pill } from "../lib/dom.mjs";
import { buildClaudeCommand } from "../lib/open-in-claude.mjs";

export function render(app) {
  const s = app.snapshot || {};
  const blocks = contextBlocks(s);
  const chosen =
    app.store.promptBlocks ||
    (app.store.promptBlocks = new Set(
      blocks.filter((b) => b.on).map((b) => b.key),
    ));

  const task = inp("textarea", {
    class: "input mono",
    rows: "3",
    placeholder: "Describe the task, e.g. fix the failing validation checks",
  });
  task.value = app.store.promptTask || "";
  const preview = inp("textarea", {
    class: "input mono prompt-preview",
    rows: "16",
  });

  const rebuild = () => {
    app.store.promptTask = task.value;
    preview.value = assemble(task.value, blocks, chosen);
    count.textContent = `${preview.value.length} chars`;
  };
  const count = el("span", { class: "muted small" });

  task.addEventListener("input", rebuild);

  const toggles = el(
    "div",
    { class: "prompt-toggles" },
    blocks.map((b) => {
      const box = inp("input", { type: "checkbox" });
      box.checked = chosen.has(b.key);
      box.disabled = b.empty;
      box.addEventListener("change", () => {
        if (box.checked) chosen.add(b.key);
        else chosen.delete(b.key);
        rebuild();
      });
      return el("label", { class: `prompt-toggle ${b.empty ? "empty" : ""}` }, [
        box,
        el("span", {
          text: `${b.label}${b.empty ? " (none)" : ` (${b.count})`}`,
        }),
      ]);
    }),
  );

  rebuild();

  return el("div", { class: "view view-prompt" }, [
    card("Prompt composer", [
      el("p", {
        class: "muted small",
        text: "Assemble a prompt with live panel context to paste into a Claude session.",
      }),
      field("Task", task),
      toggles,
      field("Preview", preview),
      el("div", { class: "btn-row" }, [
        el("button", {
          class: "btn btn-primary",
          text: "Copy prompt",
          onClick: () => copy(app, preview.value),
        }),
        count,
      ]),
    ]),
    openInClaude(app, s, preview),
    askCard(app),
  ]);
}

/**
 * Ask Clawdeck: one-question chat answered by a local `claude -p` child. The
 * thread lives in the store so navigation keeps it; this hub never re-renders
 * on snapshots, so in-flight typing is safe.
 */
function askCard(app) {
  if (!Array.isArray(app.store.askThread)) app.store.askThread = [];

  const thread = el("div", { class: "ask-thread" });
  const renderThread = () => {
    clear(thread);
    if (!app.store.askThread.length) {
      thread.append(
        el("p", {
          class: "muted small",
          text: "Ask about panel state: what is blocking a push, where spend went, which sessions are live.",
        }),
      );
      return;
    }
    for (const m of app.store.askThread) {
      const row = el("div", { class: `ask-msg ask-${m.role}` });
      row.append(
        el("span", { class: "ask-role mono small", text: m.role === "user" ? ">" : "●" }),
        el("div", { class: "ask-text", text: m.text }),
      );
      if (m.patterns?.length)
        row.append(
          el("div", { class: "ask-patterns" },
            m.patterns.map((pat) => pill(pat, "warn"))),
        );
      thread.append(row);
    }
    thread.scrollTop = thread.scrollHeight;
  };
  renderThread();

  const input = /** @type {HTMLTextAreaElement} */ (
    el("textarea", {
      class: "input",
      rows: "2",
      placeholder: "e.g. what is blocking a push right now?",
    })
  );
  const askBtn = /** @type {HTMLButtonElement} */ (
    el("button", { class: "btn btn-primary", text: "Ask" })
  );
  const busy = el("span", { class: "muted small", hidden: true }, [
    el("span", { class: "spinner-inline" }),
    el("span", { text: " thinking (runs claude -p locally)…" }),
  ]);

  const submit = async () => {
    const question = input.value.trim();
    if (!question) return;
    if (app.store.askBusy) {
      app.toast("Still answering the previous question.", "warn");
      return;
    }
    app.store.askThread.push({ role: "user", text: question });
    input.value = "";
    renderThread();
    app.store.askBusy = true;
    askBtn.disabled = true;
    busy.hidden = false;
    try {
      const r = await app.api.action("dash.ask", { question });
      if (r.refused) {
        app.store.askThread.push({
          role: "assistant",
          text: r.reason || "Refused.",
          patterns: r.patterns || [],
        });
      } else {
        app.store.askThread.push({ role: "assistant", text: r.answer || "(no answer)" });
      }
    } catch (e) {
      app.store.askThread.push({
        role: "assistant",
        text: `Error: ${String((e && e.message) || e)}`,
      });
    } finally {
      app.store.askBusy = false;
      askBtn.disabled = false;
      busy.hidden = true;
      renderThread();
    }
  };
  askBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
  });

  return card(
    "Ask Clawdeck",
    [
      thread,
      el("div", { class: "ask-controls" }, [input, askBtn, busy]),
      el("p", {
        class: "muted small",
        text: "Runs `claude -p` locally on your plan, tool-less in a sterile temp dir with no settings loaded. A compact, secret-scanned snapshot summary is the only context sent.",
      }),
    ],
    {
      help: "The child process gets no tools, no MCP servers, and no user/project instruction files; the question and summary travel on stdin only. A summary containing suspected secret material is refused before anything is sent.",
    },
  );
}

/** "Open in Claude": opens Claude in the target checkout via a claude-cli:// deep
 *  link with the prompt PREFILLED but NOT submitted (the user presses Enter).
 *  Copy prompt is a separate, always-reliable action; the label never claims the
 *  session opened, since a browser cannot confirm the OS handled the scheme. */
function openInClaude(app, s, preview) {
  const root = s.checkout?.root || ".";
  const worktreePath = s.checkout?.root || null;
  const cmd = buildClaudeCommand({ permissionMode: "plan" });

  const open = async () => {
    if (!preview.value.trim()) {
      app.toast("Write a task first.", "warn");
      return;
    }
    try {
      const r = await app.api.action("claude.open", {
        worktreePath,
        prompt: preview.value,
      });
      if (r.ok && r.url) {
        // Trigger the deep link. For a registered claude-cli:// handler this
        // opens Claude without unloading the panel; if none is installed nothing
        // happens, so the toast points at Copy prompt rather than claiming
        // success the browser cannot verify.
        const a = document.createElement("a");
        a.href = r.url;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        app.toast(
          r.truncated
            ? "Opening Claude, the prompt was truncated for the link; use Copy prompt for the full text."
            : "Opening Claude, if nothing appears, the app may not be installed; use Copy prompt.",
          r.truncated ? "warn" : "ok",
        );
      } else {
        app.toast(
          r.reason ||
            r.error ||
            "Could not build the Claude link, use Copy prompt.",
          "warn",
        );
      }
    } catch (err) {
      app.toast(String((err && err.message) || err), "err");
    }
  };

  return card("Open in Claude", [
    el("p", {
      class: "muted small",
      text: "Opens Claude in the target checkout with your prompt PREFILLED but not sent, you review it and press Enter. Uses a claude-cli:// link; if nothing opens (no handler installed), use Copy prompt. The prompt is URL-encoded, never a shell string.",
    }),
    el("pre", {
      class: "mono cp-pre",
      text: `opens: claude-cli://open?cwd=${root}&q=<prompt>\nmanual: cd "${root}" && ${cmd.display}   # then paste the prompt`,
    }),
    el("div", { class: "btn-row" }, [
      el("button", {
        class: "btn btn-primary",
        text: "Open in Claude",
        onClick: open,
      }),
      el("button", {
        class: "btn",
        text: "Copy prompt",
        onClick: () => copy(app, preview.value),
      }),
      el("button", {
        class: "btn",
        text: "Copy command",
        onClick: () => copy(app, cmd.display),
      }),
    ]),
  ]);
}

/** @returns {Array<{key:string,label:string,on:boolean,empty:boolean,count:number,text:string}>} */
function contextBlocks(s) {
  const branch = `Branch: ${s.checkout?.branch || "?"} @ ${s.checkout?.commit || "?"} (${s.checkout?.dirty ? "dirty" : "clean"})`;

  const readiness = s.readiness?.evidence || [];
  const readinessText = readiness
    .map((e) => `- [${e.ok ? "x" : " "}] ${e.label}: ${e.detail}`)
    .join("\n");

  const findings = (s.findings || []).filter((f) => !f.resolved);
  const findingsText = findings
    .map((f) =>
      `- ${f.severity} ${f.ruleId || ""} ${f.file || ""}${f.line ? `:${f.line}` : ""} ${f.title || ""}`.trim(),
    )
    .join("\n");

  const failed = (s.validation?.checks || []).filter(
    (c) => c.status === "failed",
  );
  const failedText = failed
    .map((c) => `- ${c.project || "general"}: ${c.label}`)
    .join("\n");

  const attention = s.attention || [];
  const attentionText = attention
    .map((a) => `- ${a.title}${a.detail ? ` (${a.detail})` : ""}`)
    .join("\n");

  const commits = (s.recentCommits || []).slice(0, 10);
  const commitsText = commits.map((c) => `- ${c.hash} ${c.subject}`).join("\n");

  return [
    {
      key: "branch",
      label: "Branch",
      on: true,
      empty: false,
      count: 1,
      text: branch,
    },
    {
      key: "readiness",
      label: "Push readiness",
      on: true,
      empty: !readiness.length,
      count: readiness.length,
      text: `### Push readiness\n${readinessText}`,
    },
    {
      key: "findings",
      label: "Review findings",
      on: true,
      empty: !findings.length,
      count: findings.length,
      text: `### Review findings (${findings.length})\n${findingsText}`,
    },
    {
      key: "validation",
      label: "Failing validation",
      on: true,
      empty: !failed.length,
      count: failed.length,
      text: `### Failing validation (${failed.length})\n${failedText}`,
    },
    {
      key: "attention",
      label: "Needs attention",
      on: true,
      empty: !attention.length,
      count: attention.length,
      text: `### Needs attention (${attention.length})\n${attentionText}`,
    },
    {
      key: "commits",
      label: "Recent commits",
      on: false,
      empty: !commits.length,
      count: commits.length,
      text: `### Recent commits\n${commitsText}`,
    },
  ];
}

function assemble(task, blocks, chosen) {
  const parts = [];
  if (task.trim()) parts.push(task.trim());
  const ctx = blocks
    .filter((b) => chosen.has(b.key) && !b.empty)
    .map((b) => b.text);
  if (ctx.length) parts.push(`## Context (Clawdeck)\n${ctx.join("\n\n")}`);
  return parts.join("\n\n");
}

function field(label, node) {
  return el("label", { class: "field" }, [
    el("span", { class: "field-label", text: label }),
    node,
  ]);
}

function inp(tag, attrs, children) {
  return /** @type {HTMLInputElement & HTMLTextAreaElement} */ (
    el(tag, attrs, children)
  );
}

async function copy(app, text) {
  if (!text.trim()) {
    app.toast("Nothing to copy yet.", "warn");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    app.toast("Prompt copied.", "ok");
  } catch {
    app.toast("Clipboard unavailable.", "warn");
  }
}
