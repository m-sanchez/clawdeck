import { basename, isAbsolute, normalize } from "node:path";

export const PROVIDERS = ["codex", "claude"];
export const safeId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const localPath = (value) =>
  typeof value === "string" && isAbsolute(value) && !/^[/\\]{2}/.test(value);
export const pathKey = (value) =>
  process.platform === "win32"
    ? normalize(value).toLowerCase()
    : normalize(value);
export const sessionKey = (provider, id) => `${provider}:${id}`;
const kinds = new Set([
  "start",
  "running",
  "tool",
  "attention",
  "complete",
  "interrupt",
  "error",
  "idle",
  "end",
]);

export function validEvent(event) {
  return (
    event &&
    PROVIDERS.includes(event.provider) &&
    safeId(event.sessionId) &&
    typeof event.id === "string" &&
    event.id.length <= 256 &&
    Number.isFinite(event.ts) &&
    event.ts > 0 &&
    event.ts <= Date.now() + 300000 &&
    kinds.has(event.kind) &&
    (!event.cwd || (event.cwd.length < 4096 && localPath(event.cwd)))
  );
}

export function reduceSession(previous, event) {
  if (!validEvent(event)) return previous;
  const s = previous || {
    key: sessionKey(event.provider, event.sessionId),
    provider: event.provider,
    sessionId: event.sessionId,
    cwd: "",
    title: event.sessionId.slice(0, 8),
    execution: "unknown",
    attention: null,
    result: null,
    lastTs: 0,
    turnId: null,
    turnStarted: 0,
    evidence: "inferred",
    parentId: null,
  };
  if (event.ts < s.lastTs || event.id === s.eventId) return s;
  if (
    event.turnId &&
    s.turnId &&
    event.turnId !== s.turnId &&
    event.kind !== "start"
  )
    return s;
  const next = {
    ...s,
    eventId: event.id,
    lastTs: event.ts,
    evidence: event.evidence || "inferred",
  };
  if (event.cwd) {
    next.cwd = event.cwd;
    next.title = basename(event.cwd) || event.cwd;
  }
  if (event.parentId && safeId(event.parentId))
    next.parentId = sessionKey(event.provider, event.parentId);
  if (event.turnId) next.turnId = event.turnId;
  switch (event.kind) {
    case "start":
      next.turnId = event.turnId || event.id;
      next.turnStarted = event.ts;
      next.result = null;
      next.attention = null;
      next.execution = "running";
      break;
    case "running":
    case "tool":
      next.execution = "running";
      next.attention = null;
      next.result = null;
      break;
    case "attention":
      next.attention = event.reason === "question" ? "question" : "permission";
      next.execution = "waiting";
      break;
    case "complete":
      next.execution = "idle";
      next.attention = null;
      next.result = {
        kind: "complete",
        id: `${s.key}:${s.turnId || s.turnStarted || event.id}:complete`,
        ts: event.ts,
      };
      break;
    case "interrupt":
    case "error":
      next.execution = event.kind === "error" ? "error" : "idle";
      next.attention = null;
      next.result = { kind: event.kind, id: event.id, ts: event.ts };
      break;
    case "idle":
    case "end":
      if (!previous || event.kind === "end") next.execution = "idle";
      break;
  }
  return next;
}

export function presentSession(session, acknowledgements, now = Date.now()) {
  const stale = now - session.lastTs > 15 * 60 * 1000;
  const signal = session.attention
    ? `attention:${session.eventId}`
    : session.result?.id || null;
  const unseen = Boolean(signal && acknowledgements[session.key] !== signal);
  const state = session.attention
    ? "attention"
    : session.execution === "error"
      ? "blocked"
      : session.result?.kind === "complete" && unseen
        ? "success"
        : session.execution === "running"
          ? stale
            ? "waiting"
            : "working"
          : "idle";
  return {
    ...session,
    state,
    stale,
    signal,
    unseen,
    quality:
      stale && session.execution === "running" ? "stale" : session.evidence,
    label: session.attention
      ? `Needs ${session.attention === "question" ? "an answer" : "permission"}`
      : session.execution === "running"
        ? stale
          ? "Last seen working · status unknown"
          : "Running"
        : session.result?.kind === "complete"
          ? "Turn finished"
          : session.result?.kind === "interrupt"
            ? "Interrupted"
            : session.execution === "error"
              ? "Error reported"
              : "Idle",
  };
}

export function sortSessions(sessions) {
  const rank = (s) =>
    s.stale
      ? 5
      : s.attention
        ? 0
        : s.execution === "error"
          ? 1
          : s.unseen
            ? 2
            : s.execution === "running"
              ? 3
              : 4;
  return sessions.sort(
    (a, b) =>
      rank(a) - rank(b) || b.lastTs - a.lastTs || a.key.localeCompare(b.key),
  );
}
