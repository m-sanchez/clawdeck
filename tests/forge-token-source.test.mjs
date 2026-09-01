// @ts-check
/**
 * Where a forge token comes from, and where it must never go.
 *
 * The gh CLI already holds a GitHub credential on most machines, so asking it
 * is what makes CI log reads work without the engineer configuring anything.
 * That convenience is only acceptable while it stays a LAST resort, stays
 * GitHub-only, stays skippable, and never leaves the server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgeToken, resetGhCliCache } from "../server/forge/provider.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "clawdeck-token-"));

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

test("a configured token wins and the CLI is never asked", () => {
  const root = dir();
  try {
    resetGhCliCache();
    let asked = false;
    const token = withEnv("GITHUB_TOKEN", "from-env", () =>
      forgeToken(root, "github", {
        ghRunner: () => {
          asked = true;
          return "from-cli";
        },
      }),
    );
    assert.equal(token, "from-env");
    assert.equal(asked, false, "no process may be spawned when a token exists");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with nothing configured, GitHub falls back to the CLI", () => {
  const root = dir();
  try {
    resetGhCliCache();
    const token = withEnv("GITHUB_TOKEN", null, () =>
      withEnv("CLAWDECK_NO_GH_CLI", null, () =>
        forgeToken(root, "github", { ghRunner: () => "from-cli\n" }),
      ),
    );
    assert.equal(token, "from-cli", "and the trailing newline is trimmed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the fallback is GitHub-only", () => {
  const root = dir();
  try {
    resetGhCliCache();
    let asked = false;
    const token = withEnv("GITLAB_TOKEN", null, () =>
      forgeToken(root, "gitlab", {
        ghRunner: () => {
          asked = true;
          return "from-cli";
        },
      }),
    );
    assert.equal(token, null);
    assert.equal(asked, false, "gh knows nothing about a GitLab install");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLAWDECK_NO_GH_CLI turns the fallback off entirely", () => {
  const root = dir();
  try {
    resetGhCliCache();
    let asked = false;
    const token = withEnv("GITHUB_TOKEN", null, () =>
      withEnv("CLAWDECK_NO_GH_CLI", "1", () =>
        forgeToken(root, "github", {
          ghRunner: () => {
            asked = true;
            return "from-cli";
          },
        }),
      ),
    );
    assert.equal(token, null);
    assert.equal(asked, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a CLI that fails or is absent yields no token, never an exception", () => {
  const root = dir();
  try {
    resetGhCliCache();
    const token = withEnv("GITHUB_TOKEN", null, () =>
      withEnv("CLAWDECK_NO_GH_CLI", null, () =>
        forgeToken(root, "github", {
          ghRunner: () => {
            throw new Error("ENOENT: gh is not installed");
          },
        }),
      ),
    );
    assert.equal(token, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the answer is cached, so a poll does not spawn a process per call", () => {
  const root = dir();
  try {
    resetGhCliCache();
    let calls = 0;
    const ask = () =>
      withEnv("GITHUB_TOKEN", null, () =>
        withEnv("CLAWDECK_NO_GH_CLI", null, () =>
          forgeToken(root, "github", {
            ghRunner: () => {
              calls++;
              return "from-cli";
            },
          }),
        ),
      );
    ask();
    ask();
    ask();
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
