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
  burn: BurnRate;
  findings: WasteFinding[];
}

/** Burn-rate + limit forecast (snapshot.cost.burn). Every unknown is null. */
export interface QuotaForecast {
  usedPct: number | null;
  resetsAt: string | null;
  burnPctPerHour: number | null;
  /** null when the slope is flat/negative or the reset arrives first. */
  etaToLimit: string | null;
}

export interface BurnRate {
  perHourUsd: number | null;
  windowMinutes: number;
  fiveHour: QuotaForecast;
  sevenDay: QuotaForecast;
  /** null until sample coverage reaches the minimum (see coverageHours). */
  projectedMonthUsd: number | null;
  coverageHours: number;
  samples: Array<{ t: number; usd: number }>;
  sampledAt: string | null;
  stale: boolean;
  estimated: true;
  /** Provenance of the $ figures (statusline cumulative cost deltas). */
  costSource: string;
  /** Provenance of the quota slopes (harness rate-limit percentages). */
  quotaSource: string;
}
