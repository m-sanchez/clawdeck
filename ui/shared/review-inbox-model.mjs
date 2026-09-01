// @ts-check
/**
 * Rows for one review thread, each tagged with where it came from.
 *
 * Three tiers, never mixed: `fact` is what a provider or git reported, `derived`
 * is what Clawdeck computed from those facts (and carries the evidence that
 * explains it), and `model` is Claude's advisory opinion. The view renders each
 * tier in its own visual grammar so a model opinion can never be read as a
 * provider fact - and because that separation is the product's credibility, it
 * lives here as pure data, testable in Node.
 */

export const TIERS = Object.freeze(["fact", "derived", "model"]);

const STATE_LABEL = {
  REMOTE_RESOLVED: "Resolved remotely",
  STALE: "Stale",
  NEEDS_HUMAN: "Needs a human decision",
  REPLY_DRAFTED: "Reply drafted",
  INVESTIGATING: "Investigating",
  LIKELY_ADDRESSED: "Likely addressed",
  LOCALLY_CHANGED: "Code changed locally",
  ACKNOWLEDGED: "Acknowledged",
  UNREAD: "Unread",
  OPEN: "Open",
};

const STATE_TONE = {
  REMOTE_RESOLVED: "ok",
  STALE: "neutral",
  NEEDS_HUMAN: "warn",
  REPLY_DRAFTED: "info",
  INVESTIGATING: "info",
  LIKELY_ADDRESSED: "info",
  LOCALLY_CHANGED: "info",
  ACKNOWLEDGED: "neutral",
  UNREAD: "warn",
  OPEN: "neutral",
};

/** Human wording for a remote resolution that may be genuinely unknown. */
function resolutionText(resolved) {
  if (resolved === true) return "resolved";
  if (resolved === false) return "unresolved";
  return "resolution unknown";
}

/**
 * @param {object} item        one entry from GET /api/review-inbox
 * @param {object|null} assist the advisory result for this thread, if any
 * @returns {Array<{tier:string, key:string, label:string, value?:string,
 *                  tone?:string, detail?:string, evidence?:object[]}>}
 */
export function threadRows(item, assist = null) {
  const rows = [];
  const t = item?.thread || {};
  const d = item?.derived || null;

  // FACT: what the provider said, verbatim.
  rows.push({
    tier: "fact",
    key: "location",
    label: "Location",
    value: t.location?.file
      ? `${t.location.file}${t.location.line ? `:${t.location.line}` : ""}`
      : "no code anchor",
  });
  rows.push({
    tier: "fact",
    key: "author",
    label: "Reviewer",
    value: t.author || "unknown",
  });
  rows.push({
    tier: "fact",
    key: "remote",
    label: "Remote",
    value: resolutionText(t.remote?.resolved),
    tone: t.remote?.resolved === true ? "ok" : "neutral",
    detail:
      t.remote?.resolved === null
        ? "the provider did not report a resolution state"
        : null,
  });

  // DERIVED: computed here, and never without the evidence that explains it.
  if (d) {
    rows.push({
      tier: "derived",
      key: "state",
      label: STATE_LABEL[d.state] || d.state,
      value: d.certainty === "likely" ? "likely" : undefined,
      tone: STATE_TONE[d.state] || "neutral",
      authority: d.authority,
      certainty: d.certainty,
      evidence: [
        ...(d.reasons || []).map((note) => ({ kind: d.authority, note })),
        ...(d.evidence || []),
      ],
    });
    for (const unknown of d.unknowns || [])
      rows.push({
        tier: "derived",
        key: `unknown:${unknown}`,
        label: "Unknown",
        value: unknown,
        tone: "neutral",
        certainty: "unknown",
        evidence: [
          { kind: "clawdeck", note: `${unknown} could not be determined` },
        ],
      });
  }

  // MODEL: advisory only, and only ever present because a human asked for it.
  if (assist?.answer) {
    rows.push({
      tier: "model",
      key: `assist:${assist.kind}`,
      label: "Claude assessment",
      value: assist.kind,
      detail: assist.answer,
      advisory: true,
      contextChars: assist.contextChars ?? null,
    });
  }
  return rows;
}

/** Group threads by file for the list, files with local changes first. */
export function groupByFile(items) {
  const groups = new Map();
  for (const item of items) {
    const file = item.thread?.location?.file || "(no file)";
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push(item);
  }
  return [...groups.entries()]
    .map(([file, list]) => ({
      file,
      items: list.sort(
        (a, b) =>
          (a.thread.location?.line ?? 0) - (b.thread.location?.line ?? 0),
      ),
      changed: list.some((i) => i.facts?.fileChanged === true),
    }))
    .sort(
      (a, b) =>
        Number(b.changed) - Number(a.changed) || a.file.localeCompare(b.file),
    );
}

const FILTERS = {
  all: () => true,
  unresolved: (i) => i.thread?.remote?.resolved !== true,
  blocking: (i) => i.thread?.remote?.resolved === false,
  changed: (i) => i.facts?.fileChanged === true,
  unknown: (i) => (i.derived?.unknowns || []).length > 0,
};

export function filterItems(items, filter) {
  const fn = FILTERS[filter] || FILTERS.all;
  return items.filter(fn);
}

export function filterCounts(items) {
  const counts = {};
  for (const [key, fn] of Object.entries(FILTERS))
    counts[key] = items.filter(fn).length;
  return counts;
}
