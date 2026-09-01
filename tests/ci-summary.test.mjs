// @ts-check
/**
 * CI state as a positive fact.
 *
 * The failure this guards: reading one provider's own jobs, finding none
 * failing, and calling the gate green. A pull request can be blocked by an
 * external app or a legacy commit status that the Actions API never mentions,
 * so an incomplete read is `unknown` and an empty failure list is never green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { githubChecks, summarize } from "../server/forge/github-checks.mjs";
import { FORGE, stubFetch } from "./helpers/review-thread-fixture.mjs";

const REF = "abc1234";
const checkRun = (over = {}) => ({
  id: 1,
  name: "windows / node 22",
  status: "completed",
  conclusion: "success",
  app: { slug: "github-actions" },
  html_url: "https://github.com/o/r/runs/1",
  started_at: "2026-09-01T10:00:00Z",
  completed_at: "2026-09-01T10:05:00Z",
  ...over,
});

const routes = (runs, statuses, extra = {}) => ({
  "/check-runs": { check_runs: runs, total_count: runs.length },
  "/status": { state: "success", statuses },
  ...extra,
});

test("an empty failure list is never, by itself, green", () => {
  const s = summarize([], { observedAt: "t", complete: true });
  assert.equal(s.state, "missing", "nothing to report is not a pass");

  const unread = summarize([], {
    observedAt: "t",
    complete: false,
    reason: "unreadable",
  });
  assert.equal(unread.state, "unknown");
});

test("all Actions green plus a failing external status is failing", async () => {
  const fetchImpl = stubFetch(
    routes(
      [checkRun(), checkRun({ id: 2, name: "ubuntu / node 24" })],
      [
        {
          id: 9,
          context: "SonarCloud",
          state: "failure",
          target_url: "https://sonar/x",
          created_at: "2026-09-01T10:01:00Z",
          updated_at: "2026-09-01T10:06:00Z",
        },
      ],
    ),
  );
  const r = await githubChecks(FORGE, "tok", REF, { fetchImpl });

  assert.equal(r.summary.state, "failing");
  assert.equal(r.summary.counts.failing, 1);
  assert.equal(
    r.summary.native,
    false,
    "an external context was part of the read",
  );
  assert.equal(r.failures[0].name, "SonarCloud");
  assert.equal(
    r.failures[0].inspectable,
    false,
    "no logs to fetch for an external app",
  );
});

test("everything passing across both sources is passing, and complete", async () => {
  const fetchImpl = stubFetch(
    routes([checkRun()], [{ id: 9, context: "netlify", state: "success" }]),
  );
  const r = await githubChecks(FORGE, "tok", REF, { fetchImpl });

  assert.equal(r.summary.state, "passing");
  assert.equal(r.summary.coverage.complete, true);
  assert.equal(r.summary.counts.total, 2);
});

test("a pending context outranks a passing one", async () => {
  const fetchImpl = stubFetch(
    routes(
      [
        checkRun(),
        checkRun({ id: 2, status: "in_progress", conclusion: null }),
      ],
      [],
    ),
  );
  const r = await githubChecks(FORGE, "tok", REF, { fetchImpl });
  assert.equal(r.summary.state, "pending");
});

test("reading only the native checks yields unknown, labelled native", async () => {
  // The commit-status endpoint fails: the external gate is invisible, so a
  // green cannot be claimed even though every check-run passed.
  const fetchImpl = stubFetch({
    "/check-runs": { check_runs: [checkRun()], total_count: 1 },
    "/status": { status: 500 },
  });
  const r = await githubChecks(FORGE, "tok", REF, { fetchImpl });

  assert.equal(r.summary.state, "unknown", "not passing: something was unread");
  assert.equal(r.summary.coverage.complete, false);
  assert.match(r.summary.coverage.reason, /commit statuses/);
  assert.equal(r.summary.native, true, "only native contexts were seen");
});

test("a truncated check-run listing cannot report passing", () => {
  const s = summarize([{ name: "a", state: "passing", source: "check-run" }], {
    observedAt: "t",
    complete: false,
    reason: "pagination cap",
  });
  assert.equal(s.state, "unknown");
});

test("no head commit is unknown with a reason, never missing", async () => {
  const r = await githubChecks(FORGE, "tok", null, {
    fetchImpl: stubFetch({}),
  });
  assert.equal(r.ok, false);
  assert.equal(r.summary.state, "unknown");
  assert.equal(r.summary.coverage.complete, false);
});

test("skipped and neutral conclusions are not failures", async () => {
  const fetchImpl = stubFetch(
    routes(
      [
        checkRun({ conclusion: "skipped" }),
        checkRun({ id: 2, conclusion: "neutral" }),
      ],
      [],
    ),
  );
  const r = await githubChecks(FORGE, "tok", REF, { fetchImpl });
  assert.equal(r.summary.state, "passing");
  assert.equal(r.summary.counts.failing, 0);
});

test("only requests are made, and they are GETs", async () => {
  const fetchImpl = stubFetch(routes([checkRun()], []));
  await githubChecks(FORGE, "tok", REF, { fetchImpl });
  for (const call of fetchImpl.calls) assert.equal(call.method, "GET");
});
