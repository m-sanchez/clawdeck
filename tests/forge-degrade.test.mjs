// @ts-check
/** Connector failures degrade, not crash: githubStatus returns
 * {configured:true, error} on every remote failure mode and never throws,
 * so one flaky forge cannot take down the snapshot or an SSE tick. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { githubStatus } from "../server/forge/github.mjs";

const forge = {
  project: "acme/widgets",
  apiBase: "https://api.github.invalid",
};

function withFetch(stub, run) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = real;
    });
}

test("a 401 degrades to a reported error, never a throw", async () => {
  await withFetch(
    async () => ({ ok: false, status: 401, json: async () => ({}) }),
    async () => {
      const status = await githubStatus(forge, "tok", "main");
      assert.equal(status.configured, true);
      assert.match(String(status.error), /401/);
    },
  );
});

test("a 500 degrades the same way", async () => {
  await withFetch(
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => {
      const status = await githubStatus(forge, "tok", "main");
      assert.equal(status.configured, true);
      assert.ok(status.error);
    },
  );
});

test("malformed JSON does not crash the connector", async () => {
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected end of JSON input");
      },
    }),
    async () => {
      const status = await githubStatus(forge, "tok", "main");
      assert.equal(status.configured, true);
      assert.ok(status.error);
    },
  );
});

test("a network rejection is caught and reported", async () => {
  await withFetch(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () => {
      const status = await githubStatus(forge, "tok", "main");
      assert.equal(status.configured, true);
      assert.match(String(status.error), /ECONNREFUSED/);
    },
  );
});
