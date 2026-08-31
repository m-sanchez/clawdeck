// @ts-check
/**
 * In-memory activity history. Each snapshot build records one throttled sample of
 * the live counts (active agents, running jobs, active runs) into a bounded ring
 * buffer. This is real sampled signal that accumulates while the panel runs and
 * resets on restart, the UI labels it "since panel start" so it is never read as
 * an all-time series. No persistence: nothing is written to disk.
 */

const MAX_POINTS = 240; // ~1h at the 15s sample floor
const MIN_INTERVAL_MS = 15000;

/** @type {{ t: string, activeAgents: number, runningJobs: number, activeRuns: number }[]} */
const buffer = [];
let lastSampleMs = 0;

/**
 * Record a sample if at least MIN_INTERVAL_MS has passed since the last one.
 * @param {{ t: string, activeAgents?: number, runningJobs?: number, activeRuns?: number }} sample
 * @returns {{ t: string, activeAgents: number, runningJobs: number, activeRuns: number }[]}
 */
export function recordSample(sample) {
  const ms = Date.parse(sample.t) || Date.now();
  if (buffer.length && ms - lastSampleMs < MIN_INTERVAL_MS) return getHistory();
  lastSampleMs = ms;
  buffer.push({
    t: new Date(ms).toISOString(),
    activeAgents: Math.max(0, sample.activeAgents || 0),
    runningJobs: Math.max(0, sample.runningJobs || 0),
    activeRuns: Math.max(0, sample.activeRuns || 0),
  });
  if (buffer.length > MAX_POINTS) buffer.splice(0, buffer.length - MAX_POINTS);
  return getHistory();
}

export function getHistory() {
  return buffer.slice();
}

/** Drop every sample. Test seam: module state must not leak across cases. */
export function resetHistory() {
  buffer.length = 0;
  lastSampleMs = 0;
}
