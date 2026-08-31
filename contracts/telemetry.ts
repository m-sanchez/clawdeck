/**
 * Live per-session telemetry contract. Produced by the statusline bridge
 * (`.claude/hooks/statusline-bridge.js`) and read by `adapters/telemetry-live.mjs`.
 * Cost/token fields mirror the Claude Code statusline stdin payload; all are
 * optional because the installed schema may differ from the documented one.
 */

export interface SessionTelemetry {
  sessionId: string;
  model?: string | null;
  modelId?: string | null;
  effort?: string | null;
  cwd?: string | null;
  worktree?: string | null;
  costUsd?: number | null;
  durationMs?: number | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  ctxPct?: number | null;
  ctxSize?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  cacheRead?: number | null;
  cacheCreate?: number | null;
  exceeds200k?: boolean;
  rateLimits?: {
    fiveHourPct?: number | null;
    /** Epoch SECONDS when the 5h window resets; absent on harness versions that omit it. */
    fiveHourResetsAt?: number | null;
    sevenDayPct?: number | null;
    /** Epoch SECONDS when the 7d window resets. */
    sevenDayResetsAt?: number | null;
  };
  /** Epoch ms when the sample was written. */
  ts: number;
  /** now - ts at read time; null when ts is unknown. */
  ageMs?: number | null;
  /** Older than the live window at read time. */
  stale?: boolean;
}

export interface LiveTelemetry {
  sessions: Record<string, SessionTelemetry>;
  /** Subset of `sessions` fresh within `liveWindowMs`; the ONLY input to live rollups. */
  live: Record<string, SessionTelemetry>;
  count: number;
  liveCount: number;
  historicalCount: number;
  /** Sum of the latest cost sample per live session. */
  sumLiveCostUsd: number;
  /** Sum of the latest cost sample per known session (not a time-bucketed total). */
  sumSessionCostUsd: number;
  estimated: true;
  costSource: string;
  liveWindowMs: number;
}
