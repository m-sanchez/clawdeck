import type { ClawdState } from "./clawd-state";
import type { LiveTelemetry } from "./telemetry";
import type { SessionProjection } from "./events";
import type { CostView } from "./cost";

/**
 * Plan-quota pressure. `sampledAt` is epoch milliseconds; the `*ResetsAt` fields
 * are ISO-8601 UTC, converted from the epoch SECONDS the harness reports. A band
 * is only computed from a fresh sample: `stale` true always reads `unknown`.
 */
export type QuotaPressure = {
  fiveHourPct: number | null;
  fiveHourResetsAt: string | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: string | null;
  sampledAt: number | null;
  stale: boolean;
  band: "green" | "amber" | "red" | "unknown";
  source: "statusline rate_limits (heurística informativa)";
};

export type RunPhase =
  | "queued"
  | "investigating"
  | "planning"
  | "implementing"
  | "validating"
  | "reviewing"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStatus =
  | "running"
  | "waiting"
  | "blocked"
  | "passed"
  | "failed"
  | "stopped";

export interface RunSummary {
  id: string;
  title: string;
  branch?: string;
  worktreeId?: string;
  phase: RunPhase;
  status: RunStatus;
  progress?: number;
  startedAt?: string;
  updatedAt: string;
  requiresInput?: boolean;
  blockedReason?: string;
}

export interface WorktreeSummary {
  id: string;
  path: string;
  branch: string;
  services: Array<{
    id: string;
    status: "running" | "stopped" | "failed" | "unknown";
    pid?: number;
    port?: number;
    url?: string;
  }>;
  lastActivity?: string;
}

export interface ValidationCheck {
  id: string;
  label: string;
  project?: string;
  status: "queued" | "running" | "passed" | "failed" | "skipped";
  blocking: boolean;
  command?: string;
  durationMs?: number;
  summary?: string;
}

export interface ReviewFinding {
  id: string;
  severity: "blocking" | "high" | "medium" | "low" | "advisory";
  title: string;
  description?: string;
  file?: string;
  line?: number;
  resolved: boolean;
}

export type WorkflowEvent =
  | { type: "snapshot"; emittedAt: string }
  | { type: "run.started"; run: RunSummary; emittedAt: string }
  | { type: "run.updated"; run: RunSummary; emittedAt: string }
  | {
      type: "run.phase-changed";
      runId: string;
      phase: RunPhase;
      emittedAt: string;
    }
  | {
      type: "run.attention-required";
      runId: string;
      reason: string;
      emittedAt: string;
    }
  | { type: "run.blocked"; runId: string; reason: string; emittedAt: string }
  | { type: "run.completed"; runId: string; emittedAt: string }
  | {
      type: "validation.updated";
      runId: string;
      check: ValidationCheck;
      emittedAt: string;
    }
  | {
      type: "review.updated";
      runId: string;
      finding: ReviewFinding;
      emittedAt: string;
    }
  | {
      type: "log";
      runId?: string;
      service?: string;
      level: "debug" | "info" | "warn" | "error";
      message: string;
      emittedAt: string;
    }
  | {
      type: "clawd.state";
      state: ClawdState;
      message?: string;
      emittedAt: string;
    };

/**
 * The full runtime snapshot. This interface is authoritative for the top-level
 * KEY SET (a drift test asserts the builder emits exactly these keys); nested
 * shapes are typed where a dedicated contract exists and left structural
 * elsewhere, with the runtime builder (`lib/snapshot.mjs`) as the detail source.
 */
export interface TraceSpan {
  tool: string;
  summary: string;
  startTs: string;
  /** null = unknown (unpaired in a closed turn). */
  durMs: number | null;
  /** Live-state assertion: true only while the session itself is live. */
  running: boolean;
  /** Unfinished span of a dead session; duration unknowable. */
  incomplete: boolean;
  ok: boolean | null;
  isTask: boolean;
  /** Human-wait span (plan approval / question); UI caps its width. */
  wait: boolean;
  agent: { agentType: string; description: string } | null;
}

export interface TraceTurn {
  index: number;
  startTs: string;
  endTs: string | null;
  open: boolean;
  durMs: number | null;
  model: string | null;
  gapBeforeMs: number | null;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate: number;
    requests: number;
  } | null;
  /** Capped at 80; excess reported via spansDropped. */
  spans: TraceSpan[];
  spansDropped?: number;
}

export interface SessionTrace {
  session: string;
  missing?: true;
  model: string | null;
  turns: TraceTurn[];
  /** Older history beyond the byte/turn budget was not read. */
  truncated: boolean;
  caps: { maxTurns: number; tailBytes: number };
  sessionLive: boolean;
}

export interface PanelSnapshot {
  checkout: { id: string; root: string; branch?: string; isWorktree: boolean };
  runs: RunSummary[];
  worktrees: WorktreeSummary[];
  validation: {
    status: string;
    checks: ValidationCheck[];
    passed?: boolean;
    ranAt?: string | null;
  };
  reviews: {
    status: string;
    findings: ReviewFinding[];
    blockCount: number;
    warnCount: number;
    base?: string | null;
  };
  findings: ReviewFinding[];
  attention: Array<{
    id: string;
    kind: string;
    severity: string;
    title: string;
    detail?: string | null;
    link?: string;
  }>;
  jobs: unknown[];
  sessions: { total: number; activeCount: number; agents: unknown[] };
  telemetry: LiveTelemetry;
  events: { sessions: SessionProjection[]; count: number };
  policy: { sessions: Record<string, unknown>; count: number };
  cost: CostView;
  governor: unknown;
  /**
   * Plan-quota pressure from the harness's rate-limit windows. Informational: a
   * separate axis from the API-equivalent cost rollup, and it drives no routing
   * and no gate. One sample decides every field; windows are never mixed.
   * Missing data is `unknown`, never zero.
   */
  quotaPressure: QuotaPressure;
  remoteBranches: unknown[];
  recentCommits: unknown[];
  commitActivity: unknown[];
  authorBreakdown: unknown[];
  reviewHistory: unknown;
  readiness: unknown;
  logSources: unknown;
  setup: unknown;
  /** Always-loaded instruction files + on-demand material, char-based estimates. */
  instructionBudget: {
    alwaysLoaded: Array<{
      path: string;
      chars: number;
      bytes: number;
      estTokens: number;
      reason: string;
    }>;
    onDemand: Array<{ path: string; files: number; bytes: number }>;
    totalChars: number;
    totalEstTokens: number;
    estimated: true;
    /** Real runtime evidence aggregated from InstructionsLoaded hook events.
     *  Not an estimate: the event carries no content and no size. */
    observed: {
      files: Array<{
        file: string;
        loads: number;
        sessions: number;
        lastAt: number;
        loadReason: string | null;
        memoryType: string | null;
      }>;
      fileCount: number;
      totalLoads: number;
      source: string;
    };
    note: string;
  };
  history: unknown[];
  panel: unknown;
  forge: unknown;
  delivery: {
    stages: { key: string; label: string; state: string; detail: string }[];
    blockers: string[];
    nextAction: string;
    hasChanges: boolean;
  };
  /** Panel self-performance (p50/p95 snapshot + adapter latency, counters). */
  perf: unknown;
  /**
   * Remote review threads, counts only. Comment bodies never ride here: the
   * SSE stream that carries the snapshot is the one route without a bearer,
   * and hashing large churning text every tick is waste. Full data comes from
   * the token-gated GET /api/review-inbox.
   *
   * `coverage` has two axes because listing every thread is not the same as
   * knowing every resolution (GitHub reports resolution only via GraphQL).
   * An empty result under incomplete coverage is unknown, never "clear".
   */
  reviewInbox: {
    configured: boolean;
    available: boolean;
    provider?: "github" | "gitlab" | null;
    mrIid?: number | string | null;
    reviewDecision?: string | null;
    reason?: string | null;
    detail?: string | null;
    fetchedAt?: string | null;
    freshness?: "fresh" | "stale" | "unknown";
    coverage: {
      threads: { complete: boolean; reason?: string };
      resolution: { complete: boolean; reason?: string };
    };
    degraded?: string[];
    noteCount?: number;
    counts: {
      total: number;
      remoteResolved: number;
      remoteUnresolved: number;
      resolutionUnknown: number;
      unread: number;
      needsHuman: number;
      replyDrafted: number;
      likelyAddressed: number;
      locallyChanged: number;
    } | null;
    top: Array<{
      id: string;
      file: string | null;
      line: number | null;
      state: string;
      authority: string;
      certainty: "known" | "likely" | "unknown";
    }>;
  };
  clawd: unknown;
  /**
   * Per-section FNV-1a content hashes. `version` doubles as the /api/snapshot
   * ETag. Time-driven sections (`panel`, `perf`, `history`, `emittedAt`) are
   * deliberately absent from `byKey`: consumers must treat them as always
   * changed.
   */
  sections: { version: string; byKey: Record<string, string> };
  emittedAt: string;
}
