// @ts-check
/**
 * Push-readiness adapter. Concrete evidence, not a score: does the /pre-mr review
 * marker match HEAD, is validation green, and are there zero blocking findings.
 * The marker is the same git-excluded local state the pre-push hook checks.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {{ checkoutRoot: string }} ctx
 * @param {string|null} headCommit short HEAD sha from the checkout adapter
 * @param {any} validation
 * @param {any} reviews
 */
export function getReadiness(ctx, headCommit, validation, reviews) {
  const markerPath = join(
    ctx.checkoutRoot,
    ".claude",
    ".pre-mr-state.local.json",
  );
  let marker = null;
  if (existsSync(markerPath)) {
    try {
      marker = JSON.parse(readFileSync(markerPath, "utf8"));
    } catch {
      marker = null;
    }
  }
  const reviewedHead = marker?.reviewedHead || marker?.head || null;
  const markerMatches = Boolean(
    reviewedHead && headCommit && reviewedHead.startsWith(headCommit),
  );

  const checks = validation?.checks ?? [];
  const validationFailing = checks.some((c) => c.status === "failed");
  const validationRun = validation?.status === "ok";
  const blockingFindings = Number(reviews?.blockCount) || 0;

  const evidence = [
    {
      ok: validationRun ? !validationFailing : null,
      label: "Validation passing",
      detail:
        validation?.status === "none"
          ? "Not run yet. Run Validation."
          : validationFailing
            ? "Failing checks present."
            : checks.length
              ? "All checks green."
              : "No checks in scope.",
    },
    {
      ok: reviews?.status === "ok" ? blockingFindings === 0 : null,
      label: "No blocking findings",
      detail:
        reviews?.status !== "ok"
          ? "Review scan not available."
          : blockingFindings
            ? `${blockingFindings} blocking finding(s).`
            : `${reviews.warnCount || 0} advisory finding(s).`,
    },
    {
      ok: markerMatches,
      label: "/pre-mr marker matches HEAD",
      detail: reviewedHead
        ? markerMatches
          ? `Reviewed ${reviewedHead.slice(0, 9)}.`
          : `Marker is for a different commit (${reviewedHead.slice(0, 9)}).`
        : "No /pre-mr review on record.",
    },
  ];

  const blockers = evidence.filter((e) => e.ok === false).length;
  const unknown = evidence.filter((e) => e.ok === null).length;
  const ready = blockers === 0 && unknown === 0;
  return {
    ready,
    blockers,
    unknown,
    evidence,
    head: headCommit || null,
    reviewedHead,
  };
}
