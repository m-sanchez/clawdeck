#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePanelContext } from "./lib/context.mjs";
import { loadPanelConfig } from "./lib/config.mjs";

const context = resolvePanelContext();
const { config } = await loadPanelConfig(context);
const forwarded = process.argv.slice(2);

function runFirstCandidate(label, candidates = []) {
  const found = candidates
    .map((candidate) => resolve(context.checkoutRoot, candidate))
    .find(existsSync);
  if (!found) {
    console.log(`${label}: no compatible script detected; continuing.`);
    return;
  }
  console.log(`${label}: ${found}`);
  const result = spawnSync(process.execPath, [found], {
    cwd: context.checkoutRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error(`${label} failed with exit code ${result.status}`);
}

runFirstCandidate("Worktree setup", config.worktree?.setupCandidates);
runFirstCandidate("Worktree services", config.worktree?.runCandidates);

const panelRun = resolve(context.panelRoot, "scripts", "panel-run.mjs");
const result = spawnSync(process.execPath, [panelRun, ...forwarded], {
  cwd: context.checkoutRoot,
  stdio: "inherit",
  windowsHide: true,
});
process.exit(result.status ?? 1);
