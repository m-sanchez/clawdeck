// @ts-check
/**
 * Panel-side policy transitions: locate a session's policy file across the
 * checkout + registered worktrees, apply an explicit approve/reject or
 * capability transition with optimistic concurrency, and write it back where
 * it lives (the classifier hook of THAT checkout keeps owning it). Reuses the
 * hook-owned CJS state module so panel and hooks share one transition model.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

/** Capability classes the panel may grant. Kept in the enforcement catalog. */
export function grantableCapabilities(checkoutRoot) {
  const decide = loadPolicyModules(checkoutRoot).decideMod;
  return Array.isArray(decide?.CAPABILITY_CLASSES)
    ? decide.CAPABILITY_CLASSES
    : ["dangerous"];
}

/**
 * Optional policy provider seam: the observed checkout may supply its own
 * policy/enforce modules under .claude/hooks/lib. Clawdeck ships none — with
 * no provider installed every policy action reports itself unavailable.
 */
function loadPolicyModules(checkoutRoot) {
  const base = join(checkoutRoot, ".claude", "hooks", "lib");
  let stateMod = null;
  let decideMod = null;
  try {
    stateMod = require_(join(base, "policy-state.cjs"));
  } catch {
    /* no policy provider installed */
  }
  try {
    decideMod = require_(join(base, "enforce-decide.cjs"));
  } catch {
    /* enforcement catalog optional for pure policy transitions */
  }
  return { stateMod, decideMod };
}

/**
 * Find which root currently holds the newest policy file for a session.
 * @param {string[]} roots
 * @param {string} sessionId
 * @param {any} stateMod
 * @returns {{ root:string, policy:any } | null}
 */
export function findPolicy(roots, sessionId, stateMod) {
  let best = null;
  for (const root of roots) {
    const policy = stateMod.readPolicy(root, sessionId);
    if (!policy) continue;
    let mtime = 0;
    try {
      mtime = statSync(stateMod.policyPath(root, sessionId)).mtimeMs;
    } catch {
      /* keep 0 */
    }
    const at = Number(policy.updatedAt) || mtime;
    if (!best || at > best.at) best = { root, policy, at };
  }
  return best ? { root: best.root, policy: best.policy } : null;
}

/**
 * Apply one policy action. `roots` = checkout root + registered worktree paths.
 * @param {{ checkoutRoot: string }} ctx
 * @param {string[]} roots
 * @param {"approve"|"reject"|"grant"|"revoke"} op
 * @param {Record<string, unknown>} params
 * @param {number} [now]
 */
export function runPolicyAction(ctx, roots, op, params, now = Date.now()) {
  const sessionId = String(params.sessionId ?? "");
  if (!SESSION_ID_RE.test(sessionId))
    return { ok: false, error: "Invalid session id." };
  const expectedRevision = Number(params.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    return { ok: false, error: "expectedRevision (integer) is required." };

  const { stateMod } = loadPolicyModules(ctx.checkoutRoot);
  if (!stateMod)
    return {
      ok: false,
      error: "No policy provider installed in this checkout.",
    };
  const found = findPolicy(roots, sessionId, stateMod);
  if (!found) return { ok: false, error: "No policy for that session." };

  let result;
  if (op === "approve" || op === "reject") {
    result = stateMod.applyApproval(found.policy, {
      action: op,
      expectedRevision,
      actor: "panel",
      reason: params.reason != null ? String(params.reason) : undefined,
      now,
    });
  } else {
    const name = String(params.name ?? "");
    if (!grantableCapabilities(ctx.checkoutRoot).includes(name))
      return { ok: false, error: `Capability "${name}" is not grantable.` };
    result = stateMod.applyCapability(found.policy, {
      op: op === "grant" ? "grant" : "revoke",
      name,
      ttlMs: params.ttlMs != null ? Number(params.ttlMs) : undefined,
      expectedRevision,
      actor: "panel",
      now,
    });
  }
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      stale: result.stale === true || undefined,
      currentRevision: result.currentRevision,
    };
  }
  // Compare-and-swap on the revision we read: if a classifier transition wrote
  // the policy in our read->write gap, refuse rather than clobber it (symmetric
  // with the classifier hook's own CAS).
  const cas = stateMod.writePolicyCas(
    found.root,
    result.policy,
    found.policy.revision,
  );
  if (!cas.ok) {
    return {
      ok: false,
      error: "stale revision",
      stale: true,
      currentRevision: cas.currentRevision,
    };
  }
  return {
    ok: true,
    sessionId,
    state: result.policy.state,
    revision: result.policy.revision,
    root: found.root,
  };
}
