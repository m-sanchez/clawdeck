// @ts-check
/**
 * Avoidable-spend detectors over the telemetry samples + event projection. Each
 * finding names the measurement it rests on, so an optimisation is never claimed
 * without a way to see it. Read-only: these produce advisory findings, never a
 * block.
 *
 * ATTRIBUTION HONESTY: a "reader ran on Fable" warning uses the reader
 * subagent's OWN model — from the event (`agentModels[type]`) or the pinned
 * agent config (`opts.agentModelPins`) — never the parent session model. When a
 * reader's model is genuinely unknown, no warning is emitted (we do not assume
 * it inherited Fable).
 */
const READER_TYPES = new Set([
  "Explore",
  "test-investigator",
  "plan-critic",
  "verification-auditor",
]);

/**
 * @param {{ sessions?: Record<string, any>, live?: Record<string, any> }} telemetry
 * @param {{ sessions?: any[] }} events
 * @param {{ fanoutThreshold?: number, agentModelPins?: Record<string,string> }} [opts]
 */
export function detectWaste(telemetry, events, opts = {}) {
  const fanoutThreshold = opts.fanoutThreshold ?? 12;
  const pins = opts.agentModelPins || {};
  const findings = [];
  const byId = new Map((events?.sessions || []).map((s) => [s.sessionId, s]));

  // Only reason about LIVE sessions; never fall back to telemetry.sessions
  // (which includes stale samples that must not raise a warning).
  const sessions = telemetry?.live ?? {};
  for (const [sid, t] of Object.entries(sessions)) {
    const ev = byId.get(sid);
    if (ev) {
      // Readers whose ACTUAL model resolves to Fable (event model, else pin).
      const agentModels = ev.agentModels || {};
      const fableReaders = Object.entries(ev.agentTypes || {})
        .filter(([type]) => READER_TYPES.has(type))
        .map(([type, n]) => ({
          type,
          n,
          model: agentModels[type] || pins[type] || null,
        }))
        .filter((r) => r.model && /fable/i.test(r.model));
      if (fableReaders.length)
        findings.push({
          type: "reader-on-fable",
          sessionId: sid,
          severity: "warn",
          detail: `${fableReaders
            .map((r) => `${r.n}x ${r.type} on ${r.model}`)
            .join(", ")} ran on Fable`,
          measurement:
            "reader subagent's actual/pinned model (not the parent session model)",
        });
    }
    if (ev && (ev.subagentStarts || 0) > fanoutThreshold)
      findings.push({
        type: "high-fanout",
        sessionId: sid,
        severity: "info",
        detail: `${ev.subagentStarts} subagents launched in one session`,
        measurement: "count of subagent.start events per session",
      });
  }
  return findings;
}
