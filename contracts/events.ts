/**
 * Event spine contract. The emitter (`.claude/hooks/emit-event.js`, via
 * `event-normalize.cjs`) produces EventEnvelope; the panel store validates and
 * projects it. `data` carries only redacted, non-content fields (lengths, tool
 * names, small enums) — never raw prompt/response/tool payloads.
 */

export interface EventEnvelope {
  v: 1;
  id: string;
  ts: number;
  event: string;
  session_id?: string | null;
  cwd?: string | null;
  worktreeId?: string | null;
  seq?: number;
  agent_id?: string;
  agent_type?: string;
  data?: Record<string, unknown>;
}

export type SessionState =
  | "starting"
  | "running"
  | "compacting"
  | "idle"
  | "completed"
  | "failed"
  | "stale";

export interface SessionProjection {
  sessionId: string;
  state: SessionState;
  startedAt: number;
  lastEventAt: number;
  cwd?: string | null;
  subagents: number;
  lastTool?: string | null;
  lastPromptAt?: number;
  attention?: string | null;
}
