const { cpus } = require("node:os");

function summarize(sample, previous = null, logicalCores = cpus().length || 1) {
  const prior = new Map(
    (previous?.processes || []).map((p) => [`${p.pid}:${p.started}`, p]),
  );
  const elapsed = previous ? (sample.sampledAt - previous.sampledAt) / 1000 : 0;
  const groups = ["codex", "claude", "ocelin"].map((provider) => {
    const processes = sample.processes
      .filter((p) => p.provider === provider)
      .map((p) => {
        const old = prior.get(`${p.pid}:${p.started}`);
        const delta =
          old &&
          elapsed > 0 &&
          Number.isFinite(p.cpuSeconds) &&
          Number.isFinite(old.cpuSeconds)
            ? p.cpuSeconds - old.cpuSeconds
            : null;
        return {
          pid: p.pid,
          name: p.name,
          memoryBytes: p.memoryBytes,
          cpuPercent:
            delta != null && delta >= 0
              ? Math.min(100, (delta / elapsed / logicalCores) * 100)
              : null,
        };
      })
      .sort((a, b) => (b.memoryBytes || 0) - (a.memoryBytes || 0));
    const known = processes.filter((p) => Number.isFinite(p.memoryBytes));
    const cpu = processes.filter((p) => p.cpuPercent != null);
    return {
      provider,
      processes,
      processCount: processes.length,
      unavailable: processes.length - known.length,
      memoryBytes:
        known.length || !processes.length
          ? known.reduce((sum, p) => sum + p.memoryBytes, 0)
          : null,
      cpuPercent: cpu.length
        ? Math.min(
            100,
            cpu.reduce((sum, p) => sum + p.cpuPercent, 0),
          )
        : null,
    };
  });
  return {
    status: "ready",
    sampledAt: sample.sampledAt,
    durationMs: sample.durationMs,
    groups,
    memoryBytes: groups.some((g) => g.unavailable)
      ? null
      : groups.reduce((sum, g) => sum + g.memoryBytes, 0),
  };
}

module.exports = { summarize };
