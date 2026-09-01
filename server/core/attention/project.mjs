// @ts-check
/**
 * The Attention Inbox: what needs a person, as opposed to what blocks shipping.
 *
 * These are different questions. A failing check blocks delivery and also needs
 * a person; an unpushed commit blocks delivery and needs nobody's judgement; a
 * task sitting in NEEDS_HUMAN needs a person while blocking nothing at all.
 * Collapsing them into one list makes the badge meaningless.
 *
 * The hard rule here is the advisory boundary. Claude's suggestions arrive on a
 * separate track: they never enter `items`, never move a count, never become a
 * blocker, and never touch readiness. A human promoting one with `attention.add`
 * is the only path in, and what lands is the human's record, not the model's.
 */

export const SEVERITY = Object.freeze(["blocking", "attention", "warning"]);
const ORDER = { blocking: 0, attention: 1, warning: 2 };

const item = ({
  id,
  kind,
  severity = "attention",
  title,
  detail = null,
  authority,
  link = null,
  evidence = [],
}) => ({ id, kind, severity, title, detail, authority, link, evidence });

/**
 * Authoritative attention, from facts only.
 *
 * @param {object} snapshot
 * @param {{promotions?: object[]}} [opts]
 */
export function projectAttention(snapshot, opts = {}) {
  const items = [];
  const readiness = snapshot?.deliveryReadiness || null;
  const inbox = snapshot?.reviewInbox || {};
  const tasks = snapshot?.tasks || {};
  const ci = snapshot?.ci || null;

  // A blocker that a person must decide about - changes requested, a conflict.
  // Mechanical blockers (dirty tree, unpushed commits) are deliberately absent:
  // they belong to Delivery, and putting them here trains people to ignore the
  // badge.
  for (const b of readiness?.blockers || []) {
    if (!b.needsHuman) continue;
    items.push(
      item({
        id: `blocker:${b.id}`,
        kind: b.kind,
        severity: "blocking",
        title: b.title,
        detail: b.detail,
        authority: b.authority,
        link: "#/delivery",
        evidence: b.evidence || [],
      }),
    );
  }

  // A failing check is a decision waiting to be made: fix, rerun, or accept.
  if (ci?.available && ci.summary?.state === "failing")
    items.push(
      item({
        id: "ci:failing",
        kind: "ci-failure",
        severity: "blocking",
        title: `${ci.summary.counts.failing} failing check(s)`,
        detail: (ci.failures || []).map((f) => f.name).join(", ") || null,
        authority: "ci",
        link: "#/delivery",
        evidence: [{ kind: "ci", note: `read at ${ci.observedAt}` }],
      }),
    );

  // Tasks that stopped needing a machine and started needing a person.
  for (const t of tasks?.recent || []) {
    if (t.lifecycle === "NEEDS_HUMAN")
      items.push(
        item({
          id: `task:${t.id}`,
          kind: "task",
          severity: "attention",
          title: `Task ${t.intent} is waiting on you`,
          detail: t.source?.id ?? null,
          authority: "clawdeck",
          link: "#/delivery/inbox",
          evidence: [{ kind: "task", note: `lifecycle = ${t.lifecycle}` }],
        }),
      );
    else if (t.lifecycle === "STALLED")
      items.push(
        item({
          id: `task:${t.id}`,
          kind: "task",
          severity: "warning",
          title: `Task ${t.intent} stopped progressing`,
          detail: t.sessionId ? `session ${t.sessionId.slice(0, 8)}` : null,
          authority: "clawdeck",
          link: "#/delivery/inbox",
          evidence: [{ kind: "task", note: "no progress within the window" }],
        }),
      );
  }

  // Threads the human marked. Their own mark, replayed - not a derivation.
  for (const t of inbox?.top || [])
    if (t.state === "NEEDS_HUMAN")
      items.push(
        item({
          id: `thread:${t.id}`,
          kind: "review-thread",
          severity: "attention",
          title: `${t.file ?? "conversation"}${t.line ? `:${t.line}` : ""} needs you`,
          authority: t.authority,
          link: "#/delivery/inbox",
          evidence: [{ kind: "human", note: "marked needs-human" }],
        }),
      );

  // Not knowing is itself actionable: a provider that stopped answering means
  // every "clear" on this page is unproven.
  if (inbox?.configured && !inbox.available)
    items.push(
      item({
        id: "provider:review-unavailable",
        kind: "provider",
        severity: "warning",
        title: "Review data could not be read",
        detail: inbox.reason ?? null,
        authority: "clawdeck",
        link: "#/delivery/inbox",
        evidence: [{ kind: "forge", note: inbox.detail ?? "no answer" }],
      }),
    );

  // Human promotions, recorded with who promoted them.
  for (const p of opts.promotions || [])
    items.push(
      item({
        id: `promoted:${p.id}`,
        kind: p.kind ?? "promoted",
        severity: p.severity ?? "attention",
        title: p.title,
        detail: p.detail ?? null,
        authority: "human",
        link: p.link ?? null,
        evidence: [
          { kind: "human", note: `promoted at ${p.addedAt}` },
          ...(p.origin ? [{ kind: "claude-advisory", note: p.origin }] : []),
        ],
      }),
    );

  items.sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9));
  return {
    items,
    counts: {
      total: items.length,
      blocking: items.filter((i) => i.severity === "blocking").length,
      attention: items.filter((i) => i.severity === "attention").length,
      warning: items.filter((i) => i.severity === "warning").length,
    },
  };
}

/**
 * Advisory suggestions, kept structurally apart. Every entry is stamped
 * `authority: "claude-advisory"` and `promotable: true` so no caller can mistake
 * one for a fact, and the shape deliberately has no `severity`: severity is what
 * drives the badge, and advice does not get to drive the badge.
 */
export function projectSuggested(advisory = []) {
  return advisory.slice(0, 20).map((a) => ({
    id: a.id,
    kind: a.kind ?? "suggestion",
    title: a.title,
    detail: a.detail ?? null,
    authority: "claude-advisory",
    promotable: true,
    source: a.source ?? null,
  }));
}
