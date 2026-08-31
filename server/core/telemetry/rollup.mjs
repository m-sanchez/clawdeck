// @ts-check
/**
 * Cost/usage rollups from the live telemetry samples (per-session cumulative
 * cost + model) and the event projection (subagent/compaction counts). This is
 * the honestly-derivable aggregation: precise per-request attribution to a
 * subagent needs the optional OTEL receiver, but cost-by-model and
 * subagents-by-type are available from what the panel already has.
 */
const round = (n) => Math.round(n * 1e6) / 1e6;

/**
 * @param {{ sessions?: Record<string, any>, live?: Record<string, any>,
 *   estimated?: boolean, costSource?: string }} telemetry
 * @param {{ sessions?: any[] }} events
 */
export function rollupCost(telemetry, events) {
  /** @type {Record<string, {costUsd:number, sessions:number}>} */
  const byModel = {};
  let totalCostUsd = 0;
  // Roll up ONLY the live subset into the live spend number. `live` is the
  // contract; never fall back to telemetry.sessions (which includes stale
  // sessions) — that would reintroduce stale spend into "live spend".
  const liveSessions = telemetry?.live ?? {};
  for (const t of Object.values(liveSessions)) {
    const model = t.model || "unknown";
    const cost = Number(t.costUsd) || 0;
    totalCostUsd += cost;
    if (!byModel[model]) byModel[model] = { costUsd: 0, sessions: 0 };
    byModel[model].costUsd += cost;
    byModel[model].sessions += 1;
  }
  for (const m of Object.keys(byModel))
    byModel[m].costUsd = round(byModel[m].costUsd);

  /** @type {Record<string, number>} */
  const byAgentType = {};
  let totalSubagents = 0;
  let totalCompactions = 0;
  for (const s of events?.sessions || []) {
    totalSubagents += s.subagentStarts || 0;
    totalCompactions += s.compactions || 0;
    for (const [type, n] of Object.entries(s.agentTypes || {})) {
      byAgentType[type] = (byAgentType[type] || 0) + n;
    }
  }

  const fableCost = Object.entries(byModel)
    .filter(([m]) => /fable/i.test(m))
    .reduce((sum, [, v]) => sum + v.costUsd, 0);

  return {
    totalCostUsd: round(totalCostUsd),
    byModel,
    byAgentType,
    totalSubagents,
    totalCompactions,
    fable: {
      costUsd: round(fableCost),
      share: totalCostUsd ? round(fableCost / totalCostUsd) : 0,
    },
    // Honest provenance: this is an ESTIMATE from the local statusline cost,
    // not confirmed billed spend. The UI must label it as such.
    estimated: telemetry?.estimated !== false,
    costSource:
      telemetry?.costSource ||
      "statusline cost.total_cost_usd (estimated API-equivalent)",
  };
}
