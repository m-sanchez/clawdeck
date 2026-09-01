// @ts-check
/**
 * The payload scope of the one tokenless stream, held to what docs/SECURITY.md
 * promises about it.
 *
 * SECURITY.md makes two explicit claims about `/events`: that it carries the
 * snapshot and workflow event deltas "never prompt or command text", and that
 * "review bodies, task briefs and CI job output never ride it" because payloads
 * that grow come from token-gated routes instead. `/events` is open by design -
 * EventSource cannot send headers - so those claims are the entire boundary.
 *
 * This test launches a real job through the token-gated route and reads the
 * tokenless stream as an unauthenticated listener would, asserting the job's
 * stdout never appears there. It is the wire test the boundary did not have.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PANEL = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(PANEL, "server", "start.mjs");

function freePort() {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {any} */ (s.address());
      s.close(() => resolvePort(port));
    });
  });
}

let child = null;
let runtime = "";
let port = 0;
let token = "";
const origin = () => `http://127.0.0.1:${port}`;

async function waitFor(fn, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

before(async () => {
  port = await freePort();
  runtime = mkdtempSync(join(tmpdir(), "panel-events-"));
  child = spawn(process.execPath, [ENTRY], {
    cwd: PANEL,
    env: {
      ...process.env,
      PANEL_SERVICE_PORT: String(port),
      PANEL_CHECKOUT_ROOT: PANEL,
      PANEL_REPO_ROOT: PANEL,
      PANEL_RUNTIME_DIR: runtime,
      PANEL_CHECKOUT_ID: "events-scope-test",
      PANEL_NONCE: "test-nonce",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const up = await waitFor(async () => (await fetch(`${origin()}/health`)).ok);
  assert.ok(up, "panel did not become healthy");
  token = readFileSync(join(runtime, "panel.token"), "utf8").trim();
});

after(() => {
  child?.kill();
  rmSync(runtime, { recursive: true, force: true });
});

/** Collect raw SSE text from the tokenless stream for `ms`, as any local
 * process that can reach the loopback port would see it. */
async function readEvents(ms, onOpen) {
  const controller = new AbortController();
  const response = await fetch(`${origin()}/events`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200, "/events is open by design");
  let text = "";
  const reader = /** @type {any} */ (response.body).getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      /* aborted */
    }
  })();
  await onOpen?.();
  await new Promise((r) => setTimeout(r, ms));
  controller.abort();
  await pump;
  return text;
}

/** Start an allowlisted, read-only job. The panel deliberately has no
 * arbitrary-command endpoint, so the probe uses a real registry command whose
 * output is predictable. */
async function startGitStatus(label) {
  const started = await fetch(`${origin()}/api/jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: origin(),
      "x-panel-token": token,
    },
    body: JSON.stringify({ key: "git-status", label }),
  });
  if (!started.ok) {
    assert.fail(
      `could not start the probe job (${started.status}): ${(await started.text()).slice(0, 200)}`,
    );
  }
}

test("a job's output never rides the tokenless stream", async () => {
  const stream = await readEvents(3500, () => startGitStatus("payload scope probe"));

  // `git status` prints this on every branch; it stands in for whatever a
  // command actually emits, which on a real run can include secrets.
  for (const leaked of ["On branch", "Changes not staged", "working tree"]) {
    assert.ok(
      !stream.includes(leaked),
      `a job's stdout ("${leaked}") reached an unauthenticated /events listener, which docs/SECURITY.md says never happens`,
    );
  }
});

test("the stream still reports that the job is progressing", async () => {
  // Removing the line text must not remove the signal: the cockpit needs to
  // know a job produced output, it just must not learn WHAT it produced here.
  const stream = await readEvents(3500, () => startGitStatus("progress probe"));

  assert.match(
    stream,
    /job\.(progress|started|completed)/,
    "the stream must still carry job lifecycle signal",
  );
});
