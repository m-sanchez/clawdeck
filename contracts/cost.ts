/**
 * Cost / economics rollup contract. Produced by `core/telemetry/rollup.mjs` and
 * `detectors.mjs`, exposed as `snapshot.cost` and `GET /api/cost`.
 */

export interface CostRollup {
  totalCostUsd: number;
  byModel: Record<string, { costUsd: number; sessions: number }>;
  byAgentType: Record<string, number>;
  totalSubagents: number;
  totalCompactions: number;
  fable: { costUsd: number; share: number };
}

export interface WasteFinding {
  type: string;
  sessionId: string;
  severity: "info" | "warn";
  detail: string;
  /** How this finding is measured — no optimisation is claimed without one. */
  measurement: string;
}

export interface CostView {
  rollup: CostRollup;
  findings: WasteFinding[];
}
