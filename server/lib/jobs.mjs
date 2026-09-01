// @ts-check
/**
 * Job runner for allowlisted commands. Spawns a fixed (bin, args), never a
 * shell string, streams stdout/stderr line-by-line over SSE, and tracks bounded
 * per-job state. A job may declare an artifact file (e.g. a review-pack zip) that
 * becomes downloadable through a job-scoped, path-canonicalised route.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { stopProcessTree } from "../../scripts/lib/processes.mjs";

const MAX_JOBS = 60;
const MAX_LINES = 600;
const MAX_RUNNING = 6;

let seq = 0;

export class JobManager {
  /** @param {{ broadcast: (event: string, payload: any) => void }} hub */
  constructor(hub) {
    this.hub = hub;
    /** @type {Map<string, any>} */
    this.jobs = new Map();
    /** @type {Map<string, import('node:child_process').ChildProcess>} */
    this.procs = new Map();
  }

  runningCount() {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === "running") n += 1;
    return n;
  }

  /**
   * @param {{ key: string, label: string, group: string, cwd: string, bin: string, args: string[], worktree?: string|null, artifactPath?: string|null, mutating?: boolean }} spec
   */
  start(spec) {
    if (this.runningCount() >= MAX_RUNNING) {
      return {
        ok: false,
        error: `Too many jobs running (max ${MAX_RUNNING}). Wait for one to finish.`,
      };
    }
    seq += 1;
    const id = `job-${Date.now().toString(36)}-${seq}`;
    const job = {
      id,
      key: spec.key,
      label: spec.label,
      group: spec.group,
      cwd: spec.cwd,
      worktree: spec.worktree ?? null,
      mutating: Boolean(spec.mutating),
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      lines: [],
      artifactPath: spec.artifactPath ?? null,
      artifactReady: false,
    };
    this.jobs.set(id, job);
    this._trim();
    this.hub.broadcast("job", {
      type: "job.started",
      job: summary(job),
      emittedAt: new Date().toISOString(),
    });

    const child = spawn(spec.bin, spec.args, {
      cwd: spec.cwd,
      windowsHide: true,
    });
    this.procs.set(id, child);

    let stdoutBuf = "";
    let stderrBuf = "";
    const onChunk = (level) => (chunk) => {
      const carry = level === "error" ? stderrBuf : stdoutBuf;
      const text = carry + String(chunk);
      const parts = text.split(/\r?\n/);
      const rest = parts.pop() ?? "";
      if (level === "error") stderrBuf = rest;
      else stdoutBuf = rest;
      for (const raw of parts) {
        const line = raw.trimEnd();
        if (!line) continue;
        this._emit(job, level, line);
      }
    };
    child.stdout.on("data", onChunk("info"));
    child.stderr.on("data", onChunk("error"));

    const finish = (status, exitCode) => {
      if (job.status !== "running") return;
      if (stdoutBuf.trim()) this._emit(job, "info", stdoutBuf.trim());
      if (stderrBuf.trim()) this._emit(job, "error", stderrBuf.trim());
      job.status = status;
      job.exitCode = exitCode;
      job.endedAt = new Date().toISOString();
      job.artifactReady = Boolean(
        job.artifactPath && existsSync(job.artifactPath),
      );
      this.procs.delete(id);
      this.hub.broadcast("job", {
        type: "job.completed",
        job: summary(job),
        emittedAt: new Date().toISOString(),
      });
    };

    child.on("close", (code) =>
      finish(code === 0 ? "succeeded" : "failed", code),
    );
    child.on("error", (err) => {
      this._emit(job, "error", `spawn error: ${err?.message ?? err}`);
      finish("failed", -1);
    });

    return { ok: true, jobId: id, job: summary(job) };
  }

  _emit(job, level, line) {
    job.lines.push({ level, line });
    if (job.lines.length > MAX_LINES)
      job.lines.splice(0, job.lines.length - MAX_LINES);
    // The line itself stays here. /events is the one tokenless stream, so it
    // carries the fact that output happened - never the output. A command's
    // stdout can contain anything the command chose to print, including
    // secrets, and anything that can reach the loopback port can read this
    // stream. Text comes from GET /api/jobs/:id, which requires the bearer.
    this.hub.broadcast("job", {
      type: "job.progress",
      jobId: job.id,
      level,
      lineCount: job.lines.length,
      emittedAt: new Date().toISOString(),
    });
  }

  _trim() {
    if (this.jobs.size <= MAX_JOBS) return;
    const ids = [...this.jobs.keys()];
    for (const oldId of ids.slice(0, this.jobs.size - MAX_JOBS)) {
      if (this.jobs.get(oldId)?.status !== "running") this.jobs.delete(oldId);
    }
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: "No such job" };
    if (job.status !== "running") return { ok: true, alreadyDone: true };
    const child = this.procs.get(id);
    if (child?.pid) stopProcessTree(child.pid);
    this._emit(job, "error", "cancelled by operator");
    job.status = "cancelled";
    job.endedAt = new Date().toISOString();
    this.procs.delete(id);
    this.hub.broadcast("job", {
      type: "job.completed",
      job: summary(job),
      emittedAt: new Date().toISOString(),
    });
    return { ok: true };
  }

  list() {
    return [...this.jobs.values()]
      .map(summary)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    return { ...summary(job), lines: job.lines.slice(-MAX_LINES) };
  }

  /** The on-disk artifact for a job, if ready. Returns { path, name } or null. */
  artifact(id) {
    const job = this.jobs.get(id);
    if (!job || !job.artifactPath || !existsSync(job.artifactPath)) return null;
    try {
      if (!statSync(job.artifactPath).isFile()) return null;
    } catch {
      return null;
    }
    return { path: job.artifactPath, name: basename(job.artifactPath) };
  }
}

function summary(job) {
  return {
    id: job.id,
    key: job.key,
    label: job.label,
    group: job.group,
    worktree: job.worktree,
    mutating: job.mutating,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    lineCount: job.lines.length,
    artifact: job.artifactPath
      ? { name: basename(job.artifactPath), ready: job.artifactReady }
      : null,
  };
}
