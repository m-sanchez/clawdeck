// @ts-check
/**
 * Durable task records, plus the packet each fix task hands to Claude.
 *
 * A task outlives the process that created it and the session that ran it, so
 * it is written to disk immediately and reconciled on boot rather than held in
 * memory. The packet lives in its own directory next to the record: the brief
 * can run to tens of kilobytes, which is exactly what must NOT travel in a URL
 * that browser and OS history retain.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { LIFECYCLE, isTerminal, isStalled, transition } from "./model.mjs";

export const TASK_CAP = 200;
export const STARTUP_MS = 10 * 60 * 1000;
export const IDLE_MS = 20 * 60 * 1000;

const ID_RE = /^task_[0-9a-f]{12}$/;

export function tasksDir(runtimeDir) {
  return join(runtimeDir, "tasks");
}
export function tasksPath(runtimeDir) {
  return join(tasksDir(runtimeDir), "tasks.json");
}
export function packetDir(runtimeDir, taskId) {
  return join(tasksDir(runtimeDir), taskId);
}
export function packetPath(runtimeDir, taskId) {
  return join(packetDir(runtimeDir, taskId), "TASK.md");
}

export function newTaskId() {
  return `task_${randomBytes(6).toString("hex")}`;
}
export function newMarker(taskId) {
  return `clawdeck-task:${taskId}:${randomBytes(8).toString("hex")}`;
}

export function readTasks(runtimeDir) {
  try {
    const raw = JSON.parse(readFileSync(tasksPath(runtimeDir), "utf8"));
    return Array.isArray(raw?.tasks) ? raw : { version: 1, tasks: [] };
  } catch {
    return { version: 1, tasks: [] };
  }
}

export function writeTasks(runtimeDir, store) {
  try {
    mkdirSync(tasksDir(runtimeDir), { recursive: true });
    const file = tasksPath(runtimeDir);
    const capped = { ...store, tasks: store.tasks.slice(-TASK_CAP) };
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(capped, null, 2));
    try {
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, JSON.stringify(capped, null, 2));
      rmSync(tmp, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}

export function upsertTask(store, task) {
  const tasks = store.tasks.filter((t) => t.id !== task.id);
  return { ...store, tasks: [...tasks, task] };
}

export function findTask(store, id) {
  return ID_RE.test(String(id))
    ? (store.tasks.find((t) => t.id === id) ?? null)
    : null;
}

/** Tasks still expecting something to happen. */
export function openTasks(store) {
  return store.tasks.filter((t) => !isTerminal(t.lifecycle));
}

/** The task a correlation marker belongs to, if any. */
export function taskForMarker(store, marker) {
  if (!marker) return null;
  return store.tasks.find((t) => t.correlationMarker === marker) ?? null;
}

/**
 * Write a task packet. Secret-scanned by the caller BEFORE this is called: the
 * point of the packet is that the brief never travels in a URL, not that it is
 * safe to write anything to disk.
 */
export function writePacket(runtimeDir, taskId, body) {
  if (!ID_RE.test(taskId)) return { ok: false, error: "Unknown task id." };
  try {
    mkdirSync(packetDir(runtimeDir, taskId), { recursive: true });
    const path = packetPath(runtimeDir, taskId);
    writeFileSync(path, body);
    return { ok: true, path, chars: body.length };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

export function readPacket(runtimeDir, taskId) {
  if (!ID_RE.test(taskId)) return null;
  try {
    return readFileSync(packetPath(runtimeDir, taskId), "utf8");
  } catch {
    return null;
  }
}

/** Packets are kept until the task ends; after that they are just clutter. */
export function removePacket(runtimeDir, taskId) {
  if (!ID_RE.test(taskId)) return false;
  rmSync(packetDir(runtimeDir, taskId), { recursive: true, force: true });
  return true;
}

/**
 * Move started-but-silent tasks to STALLED. Only tasks past CREATED are
 * considered, so a prompt still sitting unsent in a terminal is never marked
 * as a stalled agent.
 */
export function sweepStalled(
  store,
  { now = Date.now(), startupMs = STARTUP_MS, idleMs = IDLE_MS } = {},
) {
  let changed = false;
  const tasks = store.tasks.map((t) => {
    if (!isStalled(t, { now, startupMs, idleMs })) return t;
    const moved = transition(t, LIFECYCLE.STALLED, {
      cause:
        t.lifecycle === LIFECYCLE.STARTING
          ? "no activity after the session was bound"
          : "no activity within the idle window",
      now,
    });
    if (!moved.ok) return t;
    changed = true;
    return moved.task;
  });
  return { store: changed ? { ...store, tasks } : store, changed };
}

/**
 * Re-check open tasks against the sessions that exist now. A task whose
 * session is gone is not assumed finished; it is only reported as no longer
 * observable, and an unprovable link stays `unknown`.
 *
 * @param {object} store
 * @param {{ liveSessionIds?: Set<string>, now?: number }} [world]
 */
export function reconcileTasks(store, world = {}) {
  const live = world.liveSessionIds ?? new Set();
  const now = world.now ?? Date.now();
  let changed = false;

  const tasks = store.tasks.map((t) => {
    if (isTerminal(t.lifecycle)) return t;
    if (!t.sessionId) {
      // Never bound: the human may still not have submitted the prompt.
      return t.reconciliation === "unknown"
        ? t
        : ((changed = true), { ...t, reconciliation: "unknown" });
    }
    const stillThere = live.has(t.sessionId);
    const next = stillThere ? "bound" : "unknown";
    if (t.reconciliation === next) return t;
    changed = true;
    return {
      ...t,
      reconciliation: next,
      transitions: [
        ...t.transitions,
        {
          from: t.lifecycle,
          to: t.lifecycle,
          at: new Date(now).toISOString(),
          cause: stillThere
            ? "session observed again after restart"
            : "session no longer observable; link unproven",
        },
      ].slice(-80),
    };
  });
  return { store: changed ? { ...store, tasks } : store, changed };
}
