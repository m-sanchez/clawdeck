// @ts-check
/** ownsService proves a recorded service is the SAME process we launched:
 * a matching /health nonce owns it, a mismatched nonce (a reused PID or a
 * different service on the port) does not. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ownsService } from "../scripts/lib/health.mjs";

function healthServer(payload) {
  return new Promise((resolvePromise) => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {any} */ (srv.address());
      resolvePromise({ url: `http://127.0.0.1:${port}/health`, close: () => srv.close() });
    });
  });
}

test("a matching nonce owns the service", async () => {
  const s = await healthServer({ status: "ok", nonce: "abc" });
  try {
    assert.equal(await ownsService({ healthUrl: s.url, nonce: "abc" }), true);
  } finally {
    s.close();
  }
});

test("a mismatched nonce does not own the service (reused PID / other process)", async () => {
  const s = await healthServer({ status: "ok", nonce: "someone-else" });
  try {
    assert.equal(await ownsService({ healthUrl: s.url, nonce: "abc" }), false);
  } finally {
    s.close();
  }
});

test("no health response means no ownership", async () => {
  // nothing is listening on this port
  assert.equal(
    await ownsService({ healthUrl: "http://127.0.0.1:1/health", nonce: "abc" }),
    false,
  );
});
