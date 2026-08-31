// @ts-check
/** Unit tests for the live-telemetry adapter. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLiveTelemetry } from "../server/adapters/telemetry-live.mjs";

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tl-"));
}
function writeSession(rootDir, id, rec) {
  const dir = path.join(
    rootDir,
    ".claude",
    ".runtime",
    "telemetry",
    "sessions",
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec));
}

test("getLiveTelemetry reads records and stamps ageMs", () => {
  const a = root();
  writeSession(a, "s1", { sessionId: "s1", costUsd: 0.5, ts: 1000 });
  const out = getLiveTelemetry({ checkoutRoot: a }, [], 5000);
  assert.equal(out.count, 1);
  assert.equal(out.sessions.s1.ageMs, 4000);
  assert.equal(out.sumSessionCostUsd, 0.5);
});

test("newest sample per session wins across checkout + worktrees", () => {
  const a = root();
  const b = root();
  writeSession(a, "s1", { sessionId: "s1", costUsd: 0.1, ts: 1000 });
  writeSession(b, "s1", { sessionId: "s1", costUsd: 0.9, ts: 2000 }); // newer
  writeSession(a, "s2", { sessionId: "s2", costUsd: 0.2, ts: 1500 });
  const out = getLiveTelemetry({ checkoutRoot: a }, [{ path: b }], 3000);
  assert.equal(out.count, 2);
  assert.equal(out.sessions.s1.costUsd, 0.9); // b won
  assert.equal(out.sumSessionCostUsd, 1.1); // 0.9 + 0.2
});

test("missing dir and corrupt json are tolerated", () => {
  const a = root(); // no telemetry dir at all
  const b = root();
  const dir = path.join(b, ".claude", ".runtime", "telemetry", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bad.json"), "{ not json");
  writeSession(b, "s9", { sessionId: "s9", costUsd: 0.3, ts: 100 });
  const out = getLiveTelemetry({ checkoutRoot: a }, [{ path: b }], 200);
  assert.equal(out.count, 1);
  assert.equal(out.sessions.s9.costUsd, 0.3);
});
