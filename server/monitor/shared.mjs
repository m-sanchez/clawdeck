import { pathKey } from "./model.mjs";
let snapshot = null;
export function setMonitorSnapshot(value) {
  snapshot = value;
}
export function getMonitorSessions(checkoutRoot, worktrees = []) {
  if (!snapshot) return null;
  const paths = new Set(
    [checkoutRoot, ...worktrees.map((w) => w.path)]
      .filter(Boolean)
      .map(pathKey),
  );
  const selected = snapshot.sessions.filter(
    (s) => s.cwd && paths.has(pathKey(s.cwd)),
  );
  const agents = selected.map((s) => ({
    provider: s.provider,
    latestSessionId: s.sessionId,
    path: s.cwd,
    branch: s.title,
    active: s.execution === "running" || !!s.attention,
    lastMs: s.lastTs,
    state: s.execution === "running" ? "running" : "idle",
    eventState: s.attention ? "attention" : s.execution,
    eventSource: s.quality,
    recentSessions: [{ sessionId: s.sessionId, mtime: s.lastTs }],
    sessionCount: 1,
    name: s.title,
    taskCount: 0,
    cost: null,
    tokens: null,
  }));
  return {
    agents,
    total: agents.length,
    activeCount: agents.filter((a) => a.active).length,
  };
}
export function monitorTranscript(provider, id, cwd) {
  return (
    snapshot?.sessions.find(
      (s) =>
        s.provider === provider &&
        s.sessionId === id &&
        s.cwd &&
        pathKey(s.cwd) === pathKey(cwd),
    )?.transcript || null
  );
}
