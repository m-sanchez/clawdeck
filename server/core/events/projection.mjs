// @ts-check
/**
 * Session state machine derived from the event stream. The states are explicit:
 * starting -> running/compacting -> idle (after Stop) -> completed (after
 * SessionEnd); StopFailure -> failed; no events past T -> stale. An unclosed
 * session is never treated as running forever — Stop drops it to idle, and only
 * a fresh prompt/tool/subagent event returns it to running.
 *
 * CAUSAL ORDERING: delivery order is NOT trusted. Every state write is gated on
 * the event's timestamp (`lastStateTs`): a late-promoted OLDER event may still
 * bump counters, but can never move the projected state backwards; an equal-ms
 * tie resolves by a total STATE_RANK. Subagent liveness is a PURE function of
 * the event set — each id keeps its latest start/stop ts and is active iff its
 * start is after both its stop and the last terminal boundary — so any delivery
 * order yields the same count; id-less events fall back to a bounded counter.
 */

export const STALE_MS = 15 * 60 * 1000;
// A ts beyond now + this is not trusted to drive state (clock skew / forgery):
// such an event must never pin the high-water mark and freeze the projection.
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Derived active-subagent count as a PURE, ORDER-INDEPENDENT function of the
 * event SET: each id tracks its latest start/stop ts; it is active iff its start
 * is after both its stop AND the last terminal boundary (a start that predates a
 * terminal belongs to a finished era). Anon (id-less) events are counted from ts
 * arrays the same way. Because every stored ts is a max (or an append) and the
 * count is a filter, delivery order cannot change it. The `agents` map is NOT
 * capped — any cap-based prune would lose a stop and re-introduce order
 * dependence; per-session memory is bounded by the number of DISTINCT subagent
 * ids (small in practice) and by rotate() dropping old sessions.
 */
function subagentCount(s) {
  const term = s.lastTerminalTs || 0;
  let n = 0;
  for (const id in s.agents) {
    const a = s.agents[id];
    if (a.start > (a.stop || 0) && a.start > term) n++;
  }
  // Anon (id-less) events carry only a ts and cannot be correlated, so the count
  // is (starts after the terminal boundary) minus (stops after it) — a pure
  // filter over the two ts arrays, so delivery order cannot change it.
  const anonStart = (s.anonStarts || []).filter((t) => t > term).length;
  const anonStop = (s.anonStops || []).filter((t) => t > term).length;
  return n + Math.max(0, anonStart - anonStop);
}

/** A stale session (silence, not an event) has no running subagents. */
function resetSubagents(s) {
  s.agents = {};
  s.anonStarts = [];
  s.anonStops = [];
  s.subagents = 0;
}

/**
 * Task counts DERIVED from the per-task_id lifecycle map plus any id-less (anon)
 * fallback counters. Deriving instead of incrementing makes the counts
 * order-independent and idempotent: a duplicate task.created for the same
 * task_id collapses to one, and a completed count only rises once a matching
 * completion ts is recorded, never from delivery order.
 */
function taskCounts(s) {
  let created = s.anonTasksCreated || 0;
  let completed = s.anonTasksCompleted || 0;
  for (const id in s.tasks || {}) {
    created++;
    // An explicit `completed` flag, NOT a completedAt-truthiness test: a
    // completion whose ts is 0 (or negative) must still count as done.
    if (s.tasks[id].completed) completed++;
  }
  return { created, completed };
}

/** Deterministic serialization of an instruction record's latest-metadata
 *  fields, used only to break an exact metadata-timestamp tie so the projected
 *  metadata is delivery-order-independent. */
function instrMetaKey(m) {
  return JSON.stringify([
    m.loadReason ?? null,
    m.memoryType ?? null,
    m.globs ?? null,
    m.triggerFilePath ?? null,
    m.parentFilePath ?? null,
  ]);
}

// A total state rank makes an equal-ms tie deterministic regardless of delivery
// order: a terminal (idle/completed/failed) outranks any live state, failed >
// completed > idle among terminals, and compacting > running > starting among
// live states. At an identical ts the higher rank is kept.
const STATE_RANK = {
  starting: 0,
  running: 1,
  compacting: 2,
  idle: 3,
  completed: 4,
  failed: 5,
};
const TERMINAL_STATES = new Set(["idle", "completed", "failed"]);

/** State writes go through here so the timestamp gate is enforced everywhere. */
function setState(s, evt, state) {
  // A terminal event ALWAYS advances the terminal boundary (order-independent),
  // even when the ts gate keeps it from changing the projected state — otherwise
  // a terminal delivered behind a newer event would leave a pre-terminal phantom
  // in the count. anon has no per-event ts, so it is reset when the terminal is
  // at/after the last anon activity.
  if (TERMINAL_STATES.has(state)) {
    s.lastTerminalTs = Math.max(s.lastTerminalTs || 0, evt.ts);
    // Prune anon events the boundary supersedes (memory); the count filters too.
    const term = s.lastTerminalTs;
    s.anonStarts = (s.anonStarts || []).filter((t) => t > term);
    s.anonStops = (s.anonStops || []).filter((t) => t > term);
    s.subagents = subagentCount(s);
  }
  const cur = s.lastStateTs || 0;
  if (evt.ts < cur) return; // older event: never regress state
  if (evt.ts === cur && STATE_RANK[state] <= STATE_RANK[s.state]) return;
  s.state = state;
  s.lastStateTs = evt.ts;
}

// Attention sources are ranked so an equal-ms tie is deterministic regardless of
// delivery order (a policy/permission block outranks a generic notification); a
// strictly newer event always wins, mirroring setState's total order.
const ATTENTION_RANK = {
  notify: 0,
  "permission.denied": 1,
  "policy.denied": 2,
};
function setAttention(s, evt, kind, text) {
  const cur = s.lastAttentionAt || 0;
  if (evt.ts < cur) return;
  const rank = ATTENTION_RANK[kind];
  if (evt.ts === cur) {
    const curRank = s.lastAttentionRank ?? -1;
    if (rank < curRank) return;
    // Equal ms AND equal rank (two events of the same kind): keep a
    // deterministic winner (smaller text) so the banner is order-independent.
    if (rank === curRank && s.attention != null && !(text < s.attention))
      return;
  }
  s.attention = text;
  s.lastAttentionAt = evt.ts;
  s.lastAttentionRank = rank;
}

/**
 * Apply one event to the sessions map. Mutates and returns the map.
 * @param {Map<string, any>} sessions
 * @param {any} evt
 * @param {number} [now] used to reject a far-future ts from driving state
 */
export function applyEvent(sessions, evt, now = Date.now()) {
  const id = evt.session_id;
  if (!id) return sessions;
  // A far-future ts is untrusted: record it minimally but never let it change
  // state or advance the ordering high-water mark (that would freeze the
  // session forever, immune to reconcile).
  const suspectFuture =
    typeof evt.ts === "number" && evt.ts > now + FUTURE_SKEW_MS;
  let s = sessions.get(id);
  if (!s) {
    // Seed the liveness clocks from the CLAMPED ts: a far-future first event
    // must not latch startedAt/lastEventAt into the future (that would make
    // reconcile() never mark the session stale — a freeze on the liveness axis).
    const seedTs = suspectFuture ? now : evt.ts;
    s = {
      sessionId: id,
      state: "starting",
      startedAt: seedTs,
      lastEventAt: seedTs,
      lastStateTs: 0,
      lastCwdTs: 0,
      // cwd is established ONLY by the write-guard below (never the seed), so a
      // suspect-future first event cannot latch it and a non-positive ts still
      // gets a proper argmax base case (the guard's `s.cwd == null`).
      cwd: null,
      subagents: 0,
      subagentStarts: 0,
      agents: {},
      lastTerminalTs: 0,
      anonStarts: [],
      anonStops: [],
      agentTypes: {},
      agentModels: {},
      compactions: 0,
      prompts: 0,
      tools: 0,
      tasksCreated: 0,
      tasksCompleted: 0,
      // Real per-task lifecycle keyed by the stable task_id, plus id-less
      // fallback counters; and instruction-load records keyed by file path.
      tasks: {},
      anonTasksCreated: 0,
      anonTasksCompleted: 0,
      instructions: {},
      lastTool: null,
      attention: null,
    };
    sessions.set(id, s);
  }
  s.lastEventAt = Math.max(s.lastEventAt || 0, suspectFuture ? now : evt.ts);
  // Newest-ts-wins on its OWN high-water (not lastStateTs, which non-state events
  // never advance), with a deterministic equal-ts tiebreak (smaller cwd), so cwd
  // is delivery-order-independent like state/count/attention.
  if (evt.cwd && !suspectFuture) {
    const cur = s.lastCwdTs || 0;
    // argmax over (ts, then smaller cwd); `s.cwd == null` is the base case so a
    // first cwd of ANY finite ts (incl. <= 0) is accepted order-independently.
    if (s.cwd == null || evt.ts > cur || (evt.ts === cur && evt.cwd < s.cwd)) {
      s.cwd = evt.cwd;
      s.lastCwdTs = evt.ts;
    }
  }

  // A far-future event is recorded (lastEventAt above) but may not change state
  // or the subagent set; returning here leaves the projection unfrozen.
  if (suspectFuture) return sessions;

  switch (evt.event) {
    case "session.start":
      setState(s, evt, "running");
      // Order-independent: a late-promoted earlier session.start still wins.
      s.startedAt = Math.min(s.startedAt || evt.ts, evt.ts);
      break;
    case "prompt.submit":
      setState(s, evt, "running");
      s.lastPromptAt = Math.max(s.lastPromptAt || 0, evt.ts);
      s.prompts = (s.prompts || 0) + 1;
      break;
    case "tool.pre":
    case "tool.post":
      setState(s, evt, "running");
      s.lastTool = evt.data?.tool || s.lastTool;
      if (evt.event === "tool.pre") s.tools = (s.tools || 0) + 1;
      break;
    case "subagent.start": {
      setState(s, evt, "running");
      s.subagentStarts = (s.subagentStarts || 0) + 1;
      const type = evt.agent_type || evt.data?.agentType;
      if (type) {
        s.agentTypes[type] = (s.agentTypes[type] || 0) + 1;
        // Record the subagent's actual model (never the parent's) for honest
        // cost attribution; last observed wins per type.
        const model = evt.data?.model || evt.model || null;
        if (model) s.agentModels[type] = model;
      }
      const agentId = evt.agent_id || evt.data?.agentId || null;
      if (agentId) {
        // Record the LATEST start ts (a distinct agent reusing the id is the
        // newest start); the count filter decides activeness.
        const a = s.agents[agentId] || { start: 0, stop: 0 };
        a.start = Math.max(a.start, evt.ts);
        s.agents[agentId] = a;
      } else {
        (s.anonStarts || (s.anonStarts = [])).push(evt.ts);
      }
      s.subagents = subagentCount(s);
      break;
    }
    case "subagent.stop": {
      const agentId = evt.agent_id || evt.data?.agentId || null;
      if (agentId) {
        // Record the LATEST stop ts; the count filter (start > stop) decides.
        const a = s.agents[agentId] || { start: 0, stop: 0 };
        a.stop = Math.max(a.stop, evt.ts);
        s.agents[agentId] = a;
      } else {
        (s.anonStops || (s.anonStops = [])).push(evt.ts);
      }
      s.subagents = subagentCount(s);
      break;
    }
    case "compact.pre":
      setState(s, evt, "compacting");
      s.compactions = (s.compactions || 0) + 1;
      break;
    case "compact.post":
      setState(s, evt, "running");
      break;
    case "notify":
      // Metadata only: a generic label by type, never the notification text.
      setAttention(
        s,
        evt,
        "notify",
        evt.data?.notificationType
          ? `${evt.data.notificationType} notification`
          : "notification",
      );
      break;
    case "task.created": {
      // Real per-task lifecycle keyed by the stable task_id (the SAME value on
      // the matching task.completed). Order-independent: earliest created ts
      // wins. id-less events (older runtime) fall back to a bounded counter.
      const tid = evt.task_id || evt.data?.taskId || null;
      if (tid) {
        const t = s.tasks[tid] || {
          createdAt: null,
          completedAt: null,
          completed: false,
        };
        t.createdAt =
          t.createdAt == null ? evt.ts : Math.min(t.createdAt, evt.ts);
        s.tasks[tid] = t;
      } else s.anonTasksCreated = (s.anonTasksCreated || 0) + 1;
      const c = taskCounts(s);
      s.tasksCreated = c.created;
      s.tasksCompleted = c.completed;
      break;
    }
    case "task.completed": {
      const tid = evt.task_id || evt.data?.taskId || null;
      if (tid) {
        const t = s.tasks[tid] || {
          createdAt: null,
          completedAt: null,
          completed: false,
        };
        // A `completed` flag (not a completedAt-truthiness test) drives the
        // count, so a completion whose ts is 0/negative still counts as done.
        t.completed = true;
        t.completedAt =
          t.completedAt == null ? evt.ts : Math.max(t.completedAt, evt.ts);
        s.tasks[tid] = t;
      } else s.anonTasksCompleted = (s.anonTasksCompleted || 0) + 1;
      const c = taskCounts(s);
      s.tasksCreated = c.created;
      s.tasksCompleted = c.completed;
      break;
    }
    case "instructions.loaded": {
      // Real instruction-load observability from the InstructionsLoaded hook:
      // which file, how many loads, first/last ts, and the LATEST metadata (load
      // reason, memory type, matched globs, trigger/parent file). NEVER the
      // instruction content, the normalizer dropped it; the event carries no
      // size. Order-independent: firstAt/lastAt are min/max ts, and the
      // latest-metadata fields follow a ts high-water (newer wins; a deterministic
      // serialized key breaks an exact tie), so delivery order cannot change the
      // final state.
      const file = evt.data?.file;
      if (file) {
        const r = s.instructions[file] || {
          file,
          loads: 0,
          firstAt: null,
          lastAt: 0,
          metaTs: null,
          loadReason: null,
          memoryType: null,
          globs: null,
          triggerFilePath: null,
          parentFilePath: null,
        };
        r.loads += 1;
        r.firstAt = r.firstAt == null ? evt.ts : Math.min(r.firstAt, evt.ts);
        r.lastAt = Math.max(r.lastAt || 0, evt.ts);
        const d = evt.data || {};
        const cand = {
          loadReason: d.loadReason ?? null,
          memoryType: d.memoryType ?? null,
          globs: d.globs ?? null,
          triggerFilePath: d.triggerFilePath ?? null,
          parentFilePath: d.parentFilePath ?? null,
        };
        if (
          r.metaTs == null ||
          evt.ts > r.metaTs ||
          (evt.ts === r.metaTs && instrMetaKey(cand) < instrMetaKey(r))
        ) {
          Object.assign(r, cand);
          r.metaTs = evt.ts;
        }
        s.instructions[file] = r;
      }
      break;
    }
    case "permission.denied":
      setAttention(
        s,
        evt,
        "permission.denied",
        `permission denied: ${evt.data?.tool || "?"}`,
      );
      break;
    case "policy.denied":
      setAttention(
        s,
        evt,
        "policy.denied",
        `policy blocked ${evt.data?.tool || "?"} (${evt.data?.code || "denied"})`,
      );
      break;
    case "stop":
      setState(s, evt, "idle");
      break;
    case "stopfailure":
      setState(s, evt, "failed");
      break;
    case "session.end":
      setState(s, evt, "completed");
      break;
    default:
      break; // unknown event: bump lastEventAt only
  }
  return sessions;
}

/**
 * Mark sessions stale when they are still "live" but have gone silent past the
 * window — a crashed-mid-run session that never emitted Stop/SessionEnd.
 * @param {Map<string, any>} sessions
 * @param {number} now
 * @param {number} [staleMs]
 */
export function reconcile(sessions, now, staleMs = STALE_MS) {
  const live = new Set(["starting", "running", "compacting"]);
  for (const s of sessions.values()) {
    if (live.has(s.state) && now - (s.lastEventAt || 0) > staleMs) {
      s.state = "stale";
      resetSubagents(s);
    }
  }
  return sessions;
}
