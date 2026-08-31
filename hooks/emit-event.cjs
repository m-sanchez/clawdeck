#!/usr/bin/env node
"use strict";
/**
 * Observability emitter. Registered on the Claude Code lifecycle events, it
 * normalizes the hook payload to a redacted envelope, appends it to the
 * hook-owned durable SPOOL first, then best-effort POSTs it to the panel. The
 * spool guarantees at-least-once delivery so the panel can be down and lose
 * nothing (it promotes the spool on start). This hook must never block Claude:
 * it swallows every error and exits 0 fast.
 */
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { normalizeEvent } = require("./lib/event-normalize.cjs");
const {
  sharedEventsDir,
  appendSpool: appendSpoolTo,
  readIngestDescriptor,
} = require("./lib/event-spool.cjs");

// CLAUDE_EVENTS_CHECKOUT_ROOT is a test seam only; production resolves from
// __dirname. The events dir is the REPOSITORY-SHARED one (main checkout), so
// every worktree's events converge on the same canonical control plane.
const CHECKOUT_ROOT =
  process.env.CLAUDE_EVENTS_CHECKOUT_ROOT ||
  path.resolve(__dirname, "..", "..");
const EVENTS_DIR = sharedEventsDir(CHECKOUT_ROOT);

function appendSpool(evt, ts) {
  appendSpoolTo(EVENTS_DIR, evt, ts);
}

/** Panel address: explicit env wins, else the shared ingest descriptor. */
function panelTarget() {
  const desc = readIngestDescriptor(EVENTS_DIR);
  const envPort = Number(
    process.env.PANEL_SERVICE_PORT || process.env.PANEL_PORT,
  );
  return {
    token: desc.token,
    port: Number.isFinite(envPort) && envPort > 0 ? envPort : desc.port || 4318,
  };
}

function postEvent(evt, done) {
  let body;
  try {
    body = Buffer.from(JSON.stringify(evt));
  } catch {
    return done();
  }
  try {
    const { token, port } = panelTarget();
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/ingest/event",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          "x-panel-token": token,
          host: `127.0.0.1:${port}`,
        },
        timeout: 250,
      },
      (res) => {
        res.resume();
        res.on("end", done);
      },
    );
    req.on("error", done);
    req.on("timeout", () => {
      req.destroy();
      done();
    });
    req.end(body);
  } catch {
    done();
  }
}

function main() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    /* no stdin */
  }
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    /* leave empty */
  }
  const ts = Date.now();
  const rand = crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
  const id = `${payload.session_id || "nosess"}-${ts}-${rand}`;
  const evt = normalizeEvent(payload, { id, ts });

  try {
    appendSpool(evt, ts);
  } catch {
    /* durability best-effort; never block */
  }
  // Backstop so a hung socket can never keep the hook alive.
  const bail = setTimeout(() => process.exit(0), 300);
  bail.unref();
  postEvent(evt, () => process.exit(0));
}

if (require.main === module) main();
module.exports = { appendSpool };
