// @ts-check
/**
 * Compact dashboard summary for the ask-your-dashboard action. Everything here
 * is about to leave the panel process (into a local `claude -p` child), so the
 * builder is allowlist-shaped: small scalar keys inline, lists top-N'd, and
 * identity/path-heavy material (authors, cwds, log paths, web URLs) is never
 * included. The caller secret-scans the serialized result fail-closed.
 */

const PRIORITY = [
  "checkout",
  "readiness",
  "attention",
  "quotaPressure",
  "burn",
  "rollup",
  "findings",
  "validation",
  "runs",
  "sessions",
  "forge",
  "delivery",
  "governor",
  "commits",
  "worktrees",
  "instructionBudget",
];

const topN = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);

/**
 * @param {any} snapshot
 * @param {{ maxChars?: number }} [opts]
 * @returns {{ context: object, chars: number, dropped: string[] }}
 */
export function buildDashContext(snapshot, opts = {}) {
  const maxChars = opts.maxChars ?? 12000;
  const s = snapshot || {};

  /** @type {Record<string, any>} */
  const sections = {};

  sections.checkout = {
    id: s.checkout?.id ?? null,
    branch: s.checkout?.branch ?? null,
    dirtyCount: s.checkout?.dirtyCount ?? s.checkout?.dirty ?? null,
    ahead: s.checkout?.ahead ?? null,
    behind: s.checkout?.behind ?? null,
  };
  sections.readiness = s.readiness ?? null;
  sections.attention = topN(s.attention, 10).map((a) => ({
    severity: a.severity ?? null,
    title: a.title ?? a.message ?? null,
  }));
  sections.quotaPressure = s.quotaPressure
    ? {
        band: s.quotaPressure.band,
        fiveHourPct: s.quotaPressure.fiveHourPct,
        sevenDayPct: s.quotaPressure.sevenDayPct,
        stale: s.quotaPressure.stale,
      }
    : null;
  sections.burn = s.cost?.burn
    ? {
        perHourUsd: s.cost.burn.perHourUsd,
        fiveHour: s.cost.burn.fiveHour,
        sevenDay: s.cost.burn.sevenDay,
        projectedMonthUsd: s.cost.burn.projectedMonthUsd,
        coverageHours: s.cost.burn.coverageHours,
        stale: s.cost.burn.stale,
        estimated: true,
      }
    : null;
  sections.rollup = s.cost?.rollup
    ? {
        totalCostUsd: s.cost.rollup.totalCostUsd,
        byModel: s.cost.rollup.byModel,
        totalSubagents: s.cost.rollup.totalSubagents,
        estimated: true,
      }
    : null;
  sections.findings = topN(s.findings, 10).map((f) => ({
    ruleId: f.ruleId ?? null,
    file: f.file ?? null,
    line: f.line ?? null,
    tier: f.tier ?? f.severity ?? null,
    state: f.state ?? null,
  }));
  sections.validation = s.validation
    ? {
        ok: s.validation.ok ?? null,
        failed: topN(
          (s.validation.report ?? []).filter((r) => r.status === "fail"),
          10,
        ).map((r) => ({ check: r.check ?? r.name ?? null })),
      }
    : null;
  sections.runs = topN(s.runs?.items ?? s.runs, 5).map((r) => ({
    title: r.title ?? r.task ?? null,
    status: r.status ?? null,
    phase: r.phase ?? null,
  }));
  sections.sessions = {
    active: (s.sessions?.agents ?? []).filter((a) => a.active).length,
    total: (s.sessions?.agents ?? []).length,
    branches: topN(
      (s.sessions?.agents ?? []).map((a) => a.branch).filter(Boolean),
      8,
    ),
  };
  sections.forge = s.forge
    ? {
        configured: s.forge.configured ?? false,
        provider: s.forge.provider ?? null,
        mr: s.forge.mr
          ? {
              iid: s.forge.mr.iid,
              state: s.forge.mr.state,
              title: s.forge.mr.title,
            }
          : null,
        pipeline: s.forge.pipeline ? { status: s.forge.pipeline.status } : null,
        merged: s.forge.merged ?? null,
      }
    : null;
  sections.delivery = s.delivery ?? null;
  sections.governor = s.governor
    ? { mode: s.governor.mode, warnings: (s.governor.warnings ?? []).length }
    : null;
  sections.commits = topN(s.recentCommits, 5).map((c) => ({
    hash: c.hash ?? c.sha ?? null,
    subject: c.subject ?? c.message ?? null,
  }));
  sections.worktrees = {
    count: (s.worktrees ?? []).length ?? null,
    cleanupCandidates: topN(
      (s.worktrees ?? [])
        .filter((w) => w.cleanupClass === "safe" || w.cleanup === "safe")
        .map((w) => w.branch)
        .filter(Boolean),
      8,
    ),
  };
  sections.instructionBudget = s.instructionBudget
    ? {
        totalChars: s.instructionBudget.totalChars ?? null,
        totalEstTokens: s.instructionBudget.totalEstTokens ?? null,
      }
    : null;

  // Budget: drop lowest-priority sections until the serialization fits.
  const dropped = [];
  for (let i = PRIORITY.length - 1; i >= 0; i--) {
    const chars = JSON.stringify(sections).length;
    if (chars <= maxChars) break;
    const key = PRIORITY[i];
    if (key in sections) {
      delete sections[key];
      dropped.push(key);
    }
  }
  return {
    context: sections,
    chars: JSON.stringify(sections).length,
    dropped,
  };
}
