// @ts-check
/**
 * Derive one delivery lifecycle from the snapshot: Changed -> Validated ->
 * Reviewed -> Pre-MR -> MR -> CI -> Merged, with each stage's state, the active
 * blockers, and the single next-best action. Only stages that apply are actioned
 * (forge stages are "skipped" when no forge is configured). Pure over the
 * snapshot so it is unit-testable and identical on server and (future) client.
 */

/**
 * @param {any} snapshot
 * @returns {{ stages: {key:string,label:string,state:string,detail:string}[],
 *   blockers: string[], nextAction: string, hasChanges: boolean }}
 */
export function deriveDelivery(snapshot) {
  const c = snapshot?.checkout || {};
  const v = snapshot?.validation || {};
  const r = snapshot?.reviews || {};
  const rd = snapshot?.readiness || {};
  const gl = snapshot?.forge || {};

  const hasChanges = Boolean(c.dirty) || (c.ahead || 0) > 0;
  const stages = [];
  const blockers = [];
  const push = (key, label, state, detail) =>
    stages.push({ key, label, state, detail });

  push(
    "changed",
    "Changed",
    hasChanges ? "done" : "pending",
    hasChanges
      ? `${c.dirtyCount || 0} uncommitted · ${c.ahead || 0} ahead`
      : "working tree clean",
  );

  const valFailing =
    Array.isArray(v.checks) && v.checks.some((x) => x.status === "failed");
  if (v.passed) push("validated", "Validated", "done", "checks passing");
  else if (valFailing) {
    push("validated", "Validated", "blocked", "checks failing");
    blockers.push("Validation is failing");
  } else
    push(
      "validated",
      "Validated",
      "pending",
      v.status === "none" ? "not run" : v.status,
    );

  // Reviewed is "done" only with EVIDENCE a review actually ran and completed
  // (reviews.status === "ok"); "has changes + zero blockers" is not evidence —
  // a never-run review also has zero blockers.
  const reviewRan = r.status === "ok";
  if ((r.blockCount || 0) > 0) {
    push(
      "reviewed",
      "Reviewed",
      "blocked",
      `${r.blockCount} blocking finding(s)`,
    );
    blockers.push(`${r.blockCount} blocking review finding(s)`);
  } else if (reviewRan) {
    push("reviewed", "Reviewed", "done", `${r.warnCount || 0} advisory`);
  } else {
    push(
      "reviewed",
      "Reviewed",
      "pending",
      hasChanges ? "no review run yet" : "not run",
    );
    if (hasChanges) blockers.push("Run a review (/review-changes)");
  }

  const preOk = (rd.evidence || []).find((e) =>
    /pre-mr/i.test(e.label || ""),
  )?.ok;
  if (preOk === true) push("premr", "Pre-MR", "done", "marker matches HEAD");
  else {
    push("premr", "Pre-MR", "pending", "run /pre-mr for HEAD");
    if (hasChanges) blockers.push("Run /pre-mr for the current commit");
  }

  const pipe = gl.pipeline || gl.mr?.pipeline;
  if (!gl.configured) {
    push("mr", "MR opened", "skipped", "No forge configured");
    push("ci", "CI green", "skipped", "No forge configured");
  } else {
    if (gl.mr)
      push("mr", "MR opened", "done", `!${gl.mr.iid ?? gl.mr.number ?? ""}`);
    else push("mr", "MR opened", "pending", "no MR yet");
    if (pipe?.status === "success") push("ci", "CI green", "done", "passed");
    else if (pipe?.status === "failed") {
      push("ci", "CI green", "blocked", "failing");
      blockers.push("CI is failing");
    } else if (pipe?.status) push("ci", "CI green", "current", pipe.status);
    else push("ci", "CI green", "pending", "no pipeline");
  }

  // Merged derives ONLY from the SELECTED MR's real state. On a reused branch a
  // historical merged MR (gl.merged) with an open OR closed selected MR must
  // not read "Merged done"; the adapter always populates gl.mr when gl.merged
  // is true, so the selected state is authoritative (a closed selected MR falls
  // through to the "closed without merge" blocked branch below).
  const mrState = gl.mr?.state;
  const merged = mrState === "merged";
  if (!gl.configured)
    push("merged", "Merged", "skipped", "No forge configured");
  else if (merged)
    push("merged", "Merged", "done", `!${gl.mr?.iid ?? gl.mr?.number ?? ""}`);
  else if (mrState === "closed")
    push("merged", "Merged", "blocked", "MR closed without merge");
  else push("merged", "Merged", "pending", gl.mr ? "MR open" : "no MR");

  // Cleanup eligibility is truthful: only a merged AND clean tree qualifies.
  // A dirty tree (or unmerged) is explicitly NOT eligible — never falsely done.
  if (merged && !c.dirty && (c.ahead || 0) === 0)
    push("cleanup", "Cleanup eligible", "done", "merged + clean");
  else if (merged)
    push(
      "cleanup",
      "Cleanup eligible",
      "blocked",
      c.dirty ? "uncommitted changes present" : "commits not yet merged",
    );
  else push("cleanup", "Cleanup eligible", "pending", "not merged");

  const nextAction = !hasChanges
    ? "Nothing to deliver — working tree is clean."
    : v.status === "none"
      ? "Run validation."
      : valFailing
        ? "Fix the failing validation checks."
        : (r.blockCount || 0) > 0
          ? `Resolve ${r.blockCount} blocking review finding(s).`
          : preOk !== true
            ? "Run /pre-mr for the current commit."
            : !gl.configured
              ? "Configure a forge (GitHub/GitLab) to open a merge request."
              : !gl.mr
                ? "Open a merge request."
                : "Waiting on CI / merge.";

  return { stages, blockers, nextAction, hasChanges };
}
