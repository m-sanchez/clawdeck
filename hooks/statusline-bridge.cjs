#!/usr/bin/env node
"use strict";
/**
 * statusLine command + live-telemetry bridge. Claude Code invokes this after each
 * assistant message and /compact with a JSON status payload on stdin. We print a
 * compact status line AND, as a side effect, write an atomic per-session
 * telemetry record the panel reads for live cost/context/model. Every field is
 * optional-chained because the installed schema may differ from the documented
 * one; the bridge must never throw and break the terminal status line.
 */
const fs = require("node:fs");
const path = require("node:path");
// Optional policy provider seam: a host project may install its own
// lib/policy-state.cjs next to this hook. Absent = no policy labels.
let readPolicy = null;
try {
  ({ readPolicy } = require("./lib/policy-state.cjs"));
} catch {
  /* no policy provider installed */
}

// __dirname = <checkout>/.claude/hooks -> checkout root two levels up.
const CHECKOUT_ROOT = path.resolve(__dirname, "..", "..");
const TELEMETRY_DIR = path.join(
  CHECKOUT_ROOT,
  ".claude",
  ".runtime",
  "telemetry",
  "sessions",
);
const SHAPE_FILE = path.join(
  CHECKOUT_ROOT,
  ".claude",
  ".runtime",
  "telemetry",
  "statusline-shape.json",
);

/** Normalize the statusline stdin payload to the telemetry record. Pure. */
function normalize(input, now) {
  const i = input || {};
  const ctx = i.context_window || {};
  const usage = ctx.current_usage || {};
  const cost = i.cost || {};
  const rl = i.rate_limits || {};
  return {
    sessionId: i.session_id || null,
    model: i.model?.display_name || i.model?.id || null,
    modelId: i.model?.id || null,
    effort: i.effort?.level || null,
    cwd: i.workspace?.current_dir || i.cwd || null,
    worktree: i.workspace?.git_worktree || null,
    costUsd: num(cost.total_cost_usd),
    durationMs: num(cost.total_duration_ms),
    linesAdded: num(cost.total_lines_added),
    linesRemoved: num(cost.total_lines_removed),
    ctxPct: num(ctx.used_percentage),
    ctxSize: num(ctx.context_window_size),
    tokensIn: num(ctx.total_input_tokens),
    tokensOut: num(ctx.total_output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheCreate: num(usage.cache_creation_input_tokens),
    exceeds200k: i.exceeds_200k_tokens === true,
    rateLimits: {
      fiveHourPct: num(rl.five_hour?.used_percentage),
      // Epoch SECONDS when the harness sends it; absent on versions that do not.
      fiveHourResetsAt: num(rl.five_hour?.resets_at),
      sevenDayPct: num(rl.seven_day?.used_percentage),
      sevenDayResetsAt: num(rl.seven_day?.resets_at),
    },
    ts: now,
  };
}

/**
 * Compact one-line status string for the terminal. Pure.
 * `policy` is a short constraint label, or null when the session is
 * unconstrained — the common case, which must add no noise.
 */
function statusLine(rec, policy = null) {
  const seg = [];
  if (rec.model)
    seg.push(rec.worktree ? `${rec.model} (${rec.worktree})` : rec.model);
  if (rec.ctxPct != null) seg.push(`ctx ${Math.round(rec.ctxPct)}%`);
  if (rec.costUsd != null) seg.push(`$${rec.costUsd.toFixed(2)}`);
  if (rec.effort) seg.push(rec.effort);
  if (policy) seg.push(policy);
  return seg.join(" · ") || "…";
}

/**
 * A short label when the session's classification constrains it, else null.
 * A constraint the author cannot see is a constraint they cannot correct, and
 * `/policy` is the correction — so name the state that would send them there.
 */
function policyLabel(root, sessionId) {
  if (!sessionId || !readPolicy) return null;
  try {
    const p = readPolicy(root, sessionId);
    if (!p) return null;
    if (p.rejected) return "rejected · /policy open";
    if (p.readOnly) return "read-only · /policy open";
    if (p.approvalRequired && !p.approved) return "awaiting approval";
    return null;
  } catch {
    return null;
  }
}

/** Redacted key/type shape of a payload (values dropped) for the drift probe. */
function shapeOf(obj) {
  if (Array.isArray(obj)) return obj.length ? [shapeOf(obj[0])] : [];
  if (obj && typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = shapeOf(obj[k]);
    return out;
  }
  return typeof obj;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can reject rename-over-existing; fall back to a direct write.
    fs.writeFileSync(file, text);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function main() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    /* no stdin */
  }
  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    /* leave input empty */
  }
  const rec = normalize(input, Date.now());
  // Emit the status line first so a later write error still shows the line.
  process.stdout.write(
    statusLine(rec, policyLabel(CHECKOUT_ROOT, rec.sessionId)) + "\n",
  );
  if (!rec.sessionId) return;
  try {
    atomicWrite(
      path.join(TELEMETRY_DIR, `${rec.sessionId}.json`),
      JSON.stringify(rec),
    );
    if (!fs.existsSync(SHAPE_FILE))
      atomicWrite(SHAPE_FILE, indent(shapeOf(input)));
  } catch {
    /* telemetry is best-effort; never break the status line */
  }
}

function indent(o) {
  return JSON.stringify(o, null, 2);
}

if (require.main === module) main();
module.exports = { normalize, statusLine, policyLabel, shapeOf };
