// @ts-check
/**
 * Cross-worktree activity timeline: one chronological feed merging the
 * timestamped facts already in the snapshot (commits across every worktree,
 * autoloop runs, jobs, review + validation history, forge MR/pipeline). Pure
 * read of the snapshot; type chips filter the feed in place.
 */
import { el, card, clear, relTime, absTime, pill } from "../lib/dom.mjs";

const TYPES = {
  commit: { label: "Commits", tone: "neutral" },
  run: { label: "Runs", tone: "info" },
  job: { label: "Jobs", tone: "info" },
  review: { label: "Reviews", tone: "warn" },
  validation: { label: "Validation", tone: "ok" },
  forge: { label: "Forge", tone: "info" },
};

export function render(app) {
  const events = buildEvents(app.snapshot || {});
  const hidden =
    app.store.timelineHidden || (app.store.timelineHidden = new Set());
  const listHost = el("div", { class: "tl-list" });

  const chips = el(
    "div",
    { class: "tl-filters" },
    Object.entries(TYPES).map(([key, def]) => {
      const count = events.filter((e) => e.type === key).length;
      const chip = el("button", {
        class: `tl-chip ${hidden.has(key) ? "off" : ""}`,
        type: "button",
        text: `${def.label} ${count}`,
        onClick: () => {
          if (hidden.has(key)) hidden.delete(key);
          else hidden.add(key);
          chip.classList.toggle("off", hidden.has(key));
          draw(listHost, events, hidden);
        },
      });
      return chip;
    }),
  );

  draw(listHost, events, hidden);

  return el("div", { class: "view view-timeline" }, [
    card("Activity timeline", [
      el("p", {
        class: "muted small",
        text: `${events.length} events across ${countWorktrees(events)} worktrees. Newest first.`,
      }),
      chips,
      listHost,
    ]),
  ]);
}

function draw(listHost, events, hidden) {
  clear(listHost);
  const shown = events.filter((e) => !hidden.has(e.type));
  if (!shown.length) {
    listHost.append(
      el("p", { class: "muted small", text: "No events match the filter." }),
    );
    return;
  }
  let lastDay = "";
  for (const e of shown) {
    const day = new Date(e.at).toLocaleDateString();
    if (day !== lastDay) {
      lastDay = day;
      listHost.append(el("div", { class: "tl-day", text: day }));
    }
    listHost.append(eventRow(e));
  }
}

function eventRow(e) {
  const def = TYPES[e.type];
  const title = e.link
    ? el("a", {
        class: "tl-title link-out",
        href: e.link,
        target: "_blank",
        rel: "noopener",
        text: e.title,
      })
    : el("span", { class: "tl-title", text: e.title });
  return el("div", { class: "tl-row" }, [
    el("span", {
      class: "tl-time small muted",
      text: relTime(e.at),
      title: absTime(e.at),
    }),
    pill(def ? def.label : e.type, def ? def.tone : "neutral"),
    title,
    e.worktree
      ? el("span", { class: "tl-wt mono small", text: e.worktree })
      : null,
    e.detail
      ? el("span", { class: "tl-detail small muted", text: e.detail })
      : null,
  ]);
}

function countWorktrees(events) {
  const set = new Set();
  for (const e of events) if (e.worktree) set.add(e.worktree);
  return set.size || 1;
}

function buildEvents(s) {
  /** @type {Array<{at:string,type:string,title:string,detail?:string,worktree?:string,link?:string}>} */
  const out = [];
  const seenCommits = new Set();

  for (const c of s.recentCommits || []) {
    if (!c.date) continue;
    seenCommits.add(`${c.subject}@${c.date}`);
    out.push({
      at: c.date,
      type: "commit",
      title: c.subject,
      detail: `${c.hash} · ${c.author}`,
      worktree: s.checkout?.branch,
    });
  }

  for (const w of s.worktrees || []) {
    const lc = w.lastCommit;
    if (!lc || !lc.date) continue;
    const key = `${lc.subject}@${lc.date}`;
    if (seenCommits.has(key)) continue;
    seenCommits.add(key);
    out.push({
      at: lc.date,
      type: "commit",
      title: lc.subject,
      detail: lc.author,
      worktree: w.branch,
    });
  }

  for (const r of s.runs || []) {
    const at = r.updatedAt || r.startedAt;
    if (!at) continue;
    out.push({
      at,
      type: "run",
      title: `${r.status}: ${r.title}`,
      detail:
        r.maxIterations != null
          ? `iter ${r.iteration}/${r.maxIterations}`
          : undefined,
      worktree: r.scope || undefined,
    });
  }

  for (const j of s.jobs || []) {
    const at = j.endedAt || j.startedAt;
    if (!at) continue;
    out.push({
      at,
      type: "job",
      title: `${j.label} (${j.status})`,
      detail: j.exitCode != null ? `exit ${j.exitCode}` : undefined,
      worktree: j.worktree || undefined,
    });
  }

  for (const h of s.reviewHistory || []) {
    if (!h.at) continue;
    out.push({
      at: h.at,
      type: "review",
      title: `Review: ${h.blockCount} blocking, ${h.warnCount} warn`,
      detail: `${h.total} findings`,
    });
  }

  if (s.validation?.ranAt) {
    out.push({
      at: s.validation.ranAt,
      type: "validation",
      title: `Validation ${s.validation.passed ? "passed" : "ran"}`,
      worktree: s.validation.worktree || undefined,
    });
  }

  const gl = s.forge;
  if (gl?.configured) {
    if (gl.mr?.updatedAt)
      out.push({
        at: gl.mr.updatedAt,
        type: "forge",
        title: `MR !${gl.mr.iid}: ${gl.mr.title}`,
        link: gl.mr.webUrl,
        worktree: gl.branch || undefined,
      });
    if (gl.pipeline?.updatedAt)
      out.push({
        at: gl.pipeline.updatedAt,
        type: "forge",
        title: `Pipeline ${gl.pipeline.status}`,
        detail: gl.pipeline.sha,
        link: gl.pipeline.webUrl,
        worktree: gl.branch || undefined,
      });
  }

  return out
    .filter((e) => Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
