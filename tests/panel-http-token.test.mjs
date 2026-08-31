// @ts-check
/**
 * Live HTTP contract for the per-launch panel token: privileged routes refuse a
 * missing or wrong bearer, accept the right one, and the secret never reaches the
 * served HTML or the panel log. Boots the real server on a free port with an
 * isolated runtime dir.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PANEL = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKOUT = PANEL;
const ENTRY = join(PANEL, "server", "start.mjs");

/** An ephemeral port the OS just handed back, so the boot cannot collide. */
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
  runtime = mkdtempSync(join(tmpdir(), "panel-token-"));
  child = spawn(process.execPath, [ENTRY], {
    cwd: PANEL,
    env: {
      ...process.env,
      PANEL_SERVICE_PORT: String(port),
      PANEL_CHECKOUT_ROOT: CHECKOUT,
      PANEL_REPO_ROOT: CHECKOUT,
      PANEL_RUNTIME_DIR: runtime,
      PANEL_CHECKOUT_ID: "token-test",
      PANEL_NONCE: "test-nonce",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const up = await waitFor(async () => {
    const r = await fetch(`${origin()}/health`);
    return r.ok;
  });
  assert.ok(up, "panel did not become healthy");
  token = readFileSync(join(runtime, "panel.token"), "utf8").trim();
  assert.match(token, /^[0-9a-f]{48}$/, "a per-launch token must be written");
});

after(() => {
  child?.kill();
  rmSync(runtime, { recursive: true, force: true });
});

/** POST helper; `tok` of null omits the header entirely. */
const post = (path, tok, body = {}) =>
  fetch(`${origin()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: origin(),
      ...(tok === null ? {} : { "x-panel-token": tok }),
    },
    body: JSON.stringify(body),
  });

const get = (path, tok) =>
  fetch(`${origin()}${path}`, {
    headers: tok === null ? {} : { "x-panel-token": tok },
  });

test("privileged POST routes refuse a missing or wrong token", async () => {
  for (const path of [
    "/api/actions/config.read",
    "/api/jobs",
    "/api/jobs/abc/cancel",
    "/v1/metrics",
  ]) {
    assert.equal((await post(path, null)).status, 401, `${path} without token`);
    assert.equal(
      (await post(path, "not-the-token")).status,
      401,
      `${path} with a wrong token`,
    );
  }
});

test("sensitive reads refuse a missing token", async () => {
  for (const path of [
    "/api/session-feed?session=00000000-0000-0000-0000-000000000000",
    "/api/session-tasks?session=00000000-0000-0000-0000-000000000000",
    "/api/trace?session=00000000-0000-0000-0000-000000000000",
  ]) {
    assert.equal((await get(path, null)).status, 401, path);
  }
});

test("/api/trace validates the session id and returns the trace shape", async () => {
  assert.equal((await get("/api/trace?session=..bad..", token)).status, 400);
  const r = await get(
    "/api/trace?session=00000000-0000-0000-0000-000000000000",
    token,
  );
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.missing, true);
  assert.deepEqual(body.turns, []);
  assert.equal(typeof body.sessionLive, "boolean");
});

test("the right token is accepted", async () => {
  const r = await post("/api/actions/config.read", token);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(typeof body, "object");
});

test("liveness stays open so the lifecycle scripts keep working", async () => {
  assert.equal((await get("/health", null)).status, 200);
});

test("the token never reaches the HTML, an API body or the log", async () => {
  const html = await (await get("/", null)).text();
  assert.ok(html.length > 0, "index.html must still be served");
  assert.ok(!html.includes(token), "token must not be embedded in the HTML");

  const health = await (await get("/health", null)).text();
  assert.ok(!health.includes(token), "token must not appear in an API body");

  const logPath = join(runtime, "panel.log");
  if (existsSync(logPath)) {
    assert.ok(
      !readFileSync(logPath, "utf8").includes(token),
      "token must not be logged",
    );
  }
});
