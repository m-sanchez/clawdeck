// @ts-check
/**
 * GitLab discussion normalization. A discussion is a thread only when it is
 * resolvable; everything else is a conversation note whose resolution is
 * unknown rather than outstanding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gitlabReviewThreads } from "../server/forge/gitlab-reviews.mjs";
import {
  GL_FORGE,
  glDiscussion,
  glNote,
  stubFetch,
} from "./helpers/review-thread-fixture.mjs";

const MR = { iid: 42 };
const DISCUSSIONS = "/merge_requests/42/discussions";

test("a resolvable discussion becomes one thread with its position mapped", async () => {
  const fetchImpl = stubFetch({ [DISCUSSIONS]: [glDiscussion()] });
  const r = await gitlabReviewThreads(GL_FORGE, "tok", MR, { fetchImpl });

  assert.equal(r.ok, true);
  assert.equal(r.threads.length, 1);
  const t = r.threads[0];
  assert.equal(t.remote.resolved, false);
  assert.equal(t.remote.resolvable, true);
  assert.equal(t.remote.outdated, null, "GitLab REST does not report outdated");
  assert.deepEqual(t.location, {
    file: "server/lib/cache.mjs",
    line: 191,
    side: "new",
    anchorCommitSha: "anchor1",
  });
});

test("resolved is true only when every resolvable note is resolved", async () => {
  const partly = glDiscussion({
    notes: [
      glNote({ id: 1, resolvable: true, resolved: true }),
      glNote({ id: 2, resolvable: true, resolved: false }),
    ],
  });
  const fully = glDiscussion({
    id: "d2",
    notes: [
      glNote({ id: 3, resolvable: true, resolved: true }),
      glNote({
        id: 4,
        resolvable: true,
        resolved: true,
        resolved_by: { username: "sarah" },
      }),
    ],
  });
  const fetchImpl = stubFetch({ [DISCUSSIONS]: [partly, fully] });
  const r = await gitlabReviewThreads(GL_FORGE, "tok", MR, { fetchImpl });

  assert.equal(r.threads[0].remote.resolved, false);
  assert.equal(r.threads[1].remote.resolved, true);
  assert.equal(r.threads[1].remote.resolvedBy, "sarah");
});

test("a non-resolvable discussion is a note with no resolution state", async () => {
  const chat = glDiscussion({
    id: "d9",
    individual_note: true,
    notes: [
      glNote({
        id: 7,
        type: null,
        resolvable: false,
        resolved: null,
        position: undefined,
        body: "Looks good overall.",
      }),
    ],
  });
  const fetchImpl = stubFetch({ [DISCUSSIONS]: [chat] });
  const r = await gitlabReviewThreads(GL_FORGE, "tok", MR, { fetchImpl });

  assert.equal(r.threads.length, 0);
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0].kind, "conversation-note");
});

test("system-only discussions are dropped but counted", async () => {
  const sys = glDiscussion({
    id: "d3",
    notes: [glNote({ id: 8, system: true, body: "changed the description" })],
  });
  const fetchImpl = stubFetch({ [DISCUSSIONS]: [sys, glDiscussion()] });
  const r = await gitlabReviewThreads(GL_FORGE, "tok", MR, { fetchImpl });

  assert.equal(r.threads.length, 1);
  assert.equal(r.notes.length, 0);
  assert.equal(r.systemNoteCount, 1);
});

test("an old-side comment maps to side old", async () => {
  const removed = glDiscussion({
    notes: [
      glNote({
        position: {
          new_path: "server/lib/cache.mjs",
          old_path: "server/lib/cache.mjs",
          new_line: null,
          old_line: 88,
          head_sha: "anchor1",
        },
      }),
    ],
  });
  const fetchImpl = stubFetch({ [DISCUSSIONS]: [removed] });
  const r = await gitlabReviewThreads(GL_FORGE, "tok", MR, { fetchImpl });

  assert.equal(r.threads[0].location.side, "old");
  assert.equal(r.threads[0].location.line, 88);
});

test("no token refuses before any request is made", async () => {
  const fetchImpl = stubFetch({ [DISCUSSIONS]: [glDiscussion()] });
  const r = await gitlabReviewThreads(GL_FORGE, null, MR, { fetchImpl });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-token");
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(r.coverage.threads.complete, false);
});

test("requests are GET, page URLs are built locally, and the cap is reported", async () => {
  const page = Array.from({ length: 100 }, (_, i) =>
    glDiscussion({ id: `d${i}`, notes: [glNote({ id: 100 + i })] }),
  );
  const fetchImpl = stubFetch({ [DISCUSSIONS]: page });
  const r = await gitlabReviewThreads(GL_FORGE, "tok", MR, { fetchImpl });

  assert.equal(r.coverage.threads.complete, false);
  assert.equal(r.coverage.resolution.complete, false);
  assert.equal(fetchImpl.calls.length, 5);
  for (const [i, c] of fetchImpl.calls.entries()) {
    assert.equal(c.method, "GET");
    assert.ok(c.url.startsWith(GL_FORGE.apiBase));
    assert.ok(c.url.includes(`page=${i + 1}`));
  }
});

test("a failed fetch degrades without throwing", async () => {
  const fetchImpl = stubFetch({ [DISCUSSIONS]: { status: 500 } });
  const r = await gitlabReviewThreads(GL_FORGE, "tok", MR, { fetchImpl });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "fetch-failed");
  assert.deepEqual(r.threads, []);
});
