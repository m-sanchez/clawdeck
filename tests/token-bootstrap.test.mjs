// @ts-check
// UI token bootstrap: the fragment is consumed once, remembered, and erased.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bootstrapToken,
  panelToken,
  withToken,
} from "../ui/lib/token-bootstrap.mjs";

/** Minimal sessionStorage stand-in. */
function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  };
}

function fakeLoc(hash, pathname = "/", search = "") {
  return { hash, pathname, search };
}

function fakeHist() {
  const calls = [];
  return { replaceState: (_s, _t, url) => calls.push(url), calls };
}

test("takes the token out of the fragment, stores it, and cleans the URL", () => {
  const store = fakeStore();
  const hist = fakeHist();
  const token = bootstrapToken(fakeLoc("#token=abc123"), hist, store);
  assert.equal(token, "abc123");
  assert.equal(panelToken(store), "abc123");
  assert.deepEqual(hist.calls, ["/"]);
});

test("preserves the rest of the fragment when it carries a route", () => {
  const store = fakeStore();
  const hist = fakeHist();
  bootstrapToken(fakeLoc("#/runs&token=abc123"), hist, store);
  assert.equal(panelToken(store), "abc123");
  assert.deepEqual(hist.calls, ["/#/runs"]);
});

test("keeps a token already in storage when the URL has none", () => {
  const store = fakeStore({ "panel-token": "kept" });
  const hist = fakeHist();
  assert.equal(bootstrapToken(fakeLoc(""), hist, store), "kept");
  assert.deepEqual(hist.calls, [], "no rewrite without a fragment token");
});

test("returns null when no token was ever supplied", () => {
  assert.equal(bootstrapToken(fakeLoc(""), fakeHist(), fakeStore()), null);
});

test("survives storage being unavailable", () => {
  const broken = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  assert.equal(bootstrapToken(fakeLoc("#token=x"), fakeHist(), broken), null);
  assert.deepEqual(withToken({ method: "POST" }, broken), { method: "POST" });
});

test("withToken adds the bearer header and keeps existing init", () => {
  const store = fakeStore({ "panel-token": "t0k" });
  const init = withToken(
    { method: "POST", headers: { "content-type": "application/json" } },
    store,
  );
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.headers["x-panel-token"], "t0k");
});

test("withToken is a no-op without a token, so the server decides", () => {
  assert.deepEqual(withToken({ method: "POST" }, fakeStore()), {
    method: "POST",
  });
});
