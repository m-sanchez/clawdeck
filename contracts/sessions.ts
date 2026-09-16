export type SessionProvider = "codex" | "claude";
export type SessionExecution =
  "unknown" | "running" | "waiting" | "idle" | "error";
export interface MonitoredSession {
  key: string;
  provider: SessionProvider;
  sessionId: string;
  cwd: string;
  title: string;
  parentId: string | null;
  execution: SessionExecution;
  attention: "question" | "permission" | null;
  result: {
    kind: "complete" | "interrupt" | "error";
    id: string;
    ts: number;
  } | null;
  evidence: "hook" | "inferred";
  quality: "hook" | "inferred" | "stale";
  lastTs: number;
  turnId: string | null;
  unseen: boolean;
  stale: boolean;
}
