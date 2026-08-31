// @ts-check
/**
 * Forge connectors v2: detection for Bitbucket/Azure/Gitea remotes and
 * normalized-shape mapping for each new connector, via a stubbed fetch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRemote, detectForge } from "../server/forge/provider.mjs";
import {
  bitbucketStatus,
  bitbucketNewMrUrl,
} from "../server/forge/bitbucket.mjs";
import { giteaStatus } from "../server/forge/gitea.mjs";
import { azureStatus, azureNewMrUrl } from "../server/forge/azure.mjs";

function withFetch(stub, run) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve()
    .then(run)
    .finally(() => (globalThis.fetch = real));
}

function repoWithRemote(url) {
  const dir = mkdtempSync(join(tmpdir(), "clawdeck-forge-"));
  const git = (args) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git(["init", "-q"]);
  git(["remote", "add", "origin", url]);
  return dir;
}

test("parseRemote handles azure ssh v3 and bitbucket https", () => {
  assert.deepEqual(parseRemote("git@ssh.dev.azure.com:v3/acme/Proj/repo"), {
    host: "ssh.dev.azure.com",
    path: "v3/acme/Proj/repo",
  });
  assert.deepEqual(parseRemote("https://user@bitbucket.org/team/widget.git"), {
    host: "bitbucket.org",
    path: "team/widget",
  });
});

test("detectForge: bitbucket.org remote", async () => {
  const dir = repoWithRemote("https://bitbucket.org/team/widget.git");
  try {
    const f = await detectForge(dir);
    assert.equal(f.provider, "bitbucket");
    assert.equal(f.project, "team/widget");
    assert.equal(f.apiBase, "https://api.bitbucket.org/2.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectForge: dev.azure.com https and ssh remotes", async () => {
  for (const url of [
    "https://acme@dev.azure.com/acme/Proj/_git/repo",
    "git@ssh.dev.azure.com:v3/acme/Proj/repo",
  ]) {
    const dir = repoWithRemote(url);
    try {
      const f = await detectForge(dir);
      assert.equal(f.provider, "azuredevops", url);
      assert.equal(f.project, "Proj/repo", url);
      assert.equal(f.apiBase, "https://dev.azure.com/acme", url);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("bitbucket maps PR + pipeline to the normalized shape", async () => {
  const responses = [
    {
      values: [
        {
          id: 7,
          title: "Add widget",
          state: "OPEN",
          comment_count: 3,
          destination: { branch: { name: "main" } },
          links: {
            html: { href: "https://bitbucket.org/t/w/pull-requests/7" },
          },
          updated_on: "2026-09-01T10:00:00Z",
        },
        { id: 5, state: "MERGED", updated_on: "2026-08-30T10:00:00Z" },
      ],
    },
    {
      values: [
        {
          build_number: 42,
          state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
          target: { commit: { hash: "abcdef1234567" } },
          created_on: "2026-09-01T10:05:00Z",
        },
      ],
    },
  ];
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      json: async () => responses.shift(),
    }),
    async () => {
      const s = await bitbucketStatus(
        {
          project: "t/w",
          apiBase: "https://x",
          webBase: "https://bitbucket.org",
        },
        "tok",
        "feat/x",
      );
      assert.equal(s.provider, "bitbucket");
      assert.equal(s.mr.iid, 7);
      assert.equal(s.mr.state, "opened");
      assert.equal(s.merged, true);
      assert.equal(s.pipeline.status, "success");
      assert.equal(s.pipeline.sha, "abcdef123");
    },
  );
  assert.equal(
    bitbucketNewMrUrl(
      { webBase: "https://bitbucket.org", project: "t/w" },
      "b",
    ),
    "https://bitbucket.org/t/w/pull-requests/new?source=b",
  );
});

test("gitea filters pulls by head branch and maps commit status", async () => {
  const responses = [
    [
      { number: 2, title: "other", state: "open", head: { ref: "other" } },
      {
        number: 3,
        title: "mine",
        state: "open",
        draft: false,
        comments: 1,
        mergeable: true,
        head: { ref: "feat/x" },
        base: { ref: "main" },
        html_url: "https://gitea.example/o/r/pulls/3",
        updated_at: "2026-09-01T09:00:00Z",
      },
    ],
    { state: "failure", sha: "1234567890ab" },
  ];
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      json: async () => responses.shift(),
    }),
    async () => {
      const s = await giteaStatus(
        {
          project: "o/r",
          apiBase: "https://x",
          webBase: "https://gitea.example",
        },
        "tok",
        "feat/x",
      );
      assert.equal(s.mr.iid, 3);
      assert.equal(s.mr.state, "opened");
      assert.equal(s.pipeline.status, "failed");
    },
  );
});

test("azure maps PRs/builds and degrades on HTTP failure", async () => {
  const responses = [
    {
      value: [
        {
          pullRequestId: 11,
          title: "AZ change",
          status: "active",
          isDraft: false,
          mergeStatus: "succeeded",
          targetRefName: "refs/heads/main",
          creationDate: "2026-09-01T08:00:00Z",
        },
      ],
    },
    {
      value: [
        {
          id: 99,
          status: "completed",
          result: "succeeded",
          sourceVersion: "fedcba9876543",
          finishTime: "2026-09-01T08:30:00Z",
        },
      ],
    },
  ];
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      json: async () => responses.shift(),
    }),
    async () => {
      const s = await azureStatus(
        {
          project: "Proj/repo",
          apiBase: "https://dev.azure.com/acme",
          webBase: "https://dev.azure.com/acme",
        },
        "pat",
        "feat/x",
      );
      assert.equal(s.mr.iid, 11);
      assert.equal(s.mr.state, "opened");
      assert.equal(s.mr.target, "main");
      assert.equal(s.pipeline.status, "success");
      assert.ok(s.mr.webUrl.endsWith("/pullrequest/11"));
    },
  );
  await withFetch(
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => {
      const s = await azureStatus(
        { project: "Proj/repo", apiBase: "https://x", webBase: "https://x" },
        "pat",
        "b",
      );
      assert.equal(s.configured, true);
      assert.match(String(s.error), /500/);
    },
  );
  assert.equal(
    azureNewMrUrl(
      { webBase: "https://dev.azure.com/acme", project: "Proj/repo" },
      "b",
      "main",
    ),
    "https://dev.azure.com/acme/Proj/_git/repo/pullrequestcreate?sourceRef=b&targetRef=main",
  );
});
