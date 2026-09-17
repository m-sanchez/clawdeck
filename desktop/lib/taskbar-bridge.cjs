const { writeFileSync, renameSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

function taskbarSummary(state, enabled, now = Date.now()) {
  const ready = enabled && !state.error;
  const fresh =
    state.resources?.status === "ready" &&
    now - state.resources.sampledAt < 35000;
  const groups = (state.resources?.groups || []).filter(
    (g) => g.provider !== "ocelin",
  );
  const complete =
    groups.length > 0 &&
    groups.every((g) => Number.isFinite(g.memoryBytes) && !g.unavailable);
  return {
    schemaVersion: 1,
    sampledAt: now,
    status: !enabled ? "disabled" : ready ? "ready" : "unavailable",
    running: ready ? state.counts.running : null,
    attention: ready ? state.counts.attention : null,
    memoryBytes:
      ready && fresh && complete
        ? groups.reduce((n, g) => n + g.memoryBytes, 0)
        : null,
  };
}
class TaskbarBridge {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, "taskbar-summary.json");
  }
  publish(state, enabled) {
    if (!enabled && !this.wasEnabled) return;
    this.wasEnabled = enabled;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(
        `${this.file}.tmp`,
        JSON.stringify(taskbarSummary(state, enabled)),
        { mode: 0o600 },
      );
      renameSync(`${this.file}.tmp`, this.file);
    } catch {}
  }
}
module.exports = { TaskbarBridge, taskbarSummary };
