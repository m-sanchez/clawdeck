// @ts-check
/**
 * Host vitals for the Health view: CPU, memory, and the disk the observed
 * checkout lives on. Pure Node stdlib. CPU is a delta between successive
 * samples, so the first reading reports null rather than a guess; absent or
 * unsupported values stay null, never zero.
 */
import os from "node:os";
import { statfsSync } from "node:fs";

/** Aggregate {idle, total} ticks across cores. */
export function cpuTotals(cpus) {
  let idle = 0;
  let total = 0;
  for (const c of cpus || []) {
    for (const [k, v] of Object.entries(c.times || {})) {
      total += v;
      if (k === "idle") idle += v;
    }
  }
  return { idle, total };
}

/** CPU busy percentage between two tick samples, or null when unmeasurable. */
export function computeCpuPct(prev, next) {
  if (!prev || !next) return null;
  const dTotal = next.total - prev.total;
  const dIdle = next.idle - prev.idle;
  if (!(dTotal > 0) || dIdle < 0) return null;
  const pct = ((dTotal - dIdle) / dTotal) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

let lastCpu = null;

/**
 * One host sample. CPU needs a prior call to have happened (snapshot cadence
 * provides that); disk reflects the volume holding `diskPath`.
 * @param {string} diskPath
 * @param {{ os?: any, statfs?: (p: string) => any, reset?: boolean }} [seams] test injection
 */
export function sampleHostMetrics(diskPath, seams = {}) {
  const osApi = seams.os || os;
  if (seams.reset) lastCpu = null;

  const now = cpuTotals(osApi.cpus());
  const cpuPct = computeCpuPct(lastCpu, now);
  lastCpu = now;

  const totalMem = osApi.totalmem();
  const freeMem = osApi.freemem();
  const memUsedPct =
    totalMem > 0
      ? Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10
      : null;

  let disk = null;
  try {
    const statfs = seams.statfs || statfsSync;
    const st = statfs(diskPath);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    if (total > 0)
      disk = {
        totalGB: Math.round(total / 1073741824),
        freeGB: Math.round((free / 1073741824) * 10) / 10,
        usedPct: Math.round(((total - free) / total) * 1000) / 10,
      };
  } catch {
    /* unsupported platform/volume: stay null */
  }

  return {
    cpuPct,
    cores: (osApi.cpus() || []).length,
    memUsedPct,
    memTotalMB: totalMem > 0 ? Math.round(totalMem / 1048576) : null,
    memFreeMB: freeMem >= 0 ? Math.round(freeMem / 1048576) : null,
    disk,
    sampledAt: Date.now(),
  };
}

/** Tone thresholds shared with the UI: green under warn, amber under danger. */
export const HOST_THRESHOLDS = { warnPct: 80, dangerPct: 92 };
