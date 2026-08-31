#!/usr/bin/env node
// @ts-check
/**
 * Read-only worktree footprint: sum file sizes under a directory, excluding the
 * heavy generated/dependency trees (node_modules, .git, build output) and never
 * following symlinks or Windows junctions (so the node_modules junction into the
 * main checkout is not counted). Prints a human summary; mutates nothing.
 *
 * Usage: node wt-disk.mjs <dir>
 */
import { readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] || process.cwd();
const SKIP = new Set([
  "node_modules",
  ".git",
  ".runtime",
  ".wt-runtime",
  "dist",
  "build",
  ".angular",
  ".nx",
  "coverage",
  ".cache",
]);

let totalFiles = 0;

/** Recursively sum file bytes under dir, skipping SKIP dirs and symlinks/junctions. */
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let size = 0;
  for (const e of entries) {
    const full = join(dir, e.name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // junction or symlink: do not follow/count
    if (st.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      size += walk(full);
    } else if (st.isFile()) {
      size += st.size;
      totalFiles += 1;
    }
  }
  return size;
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const skipped = [];
const topDirs = [];
let total = 0;
let rootEntries = [];
try {
  rootEntries = readdirSync(root, { withFileTypes: true });
} catch (err) {
  console.error(`Cannot read ${root}: ${err.message}`);
  process.exit(1);
}
for (const e of rootEntries) {
  const full = join(root, e.name);
  let st;
  try {
    st = lstatSync(full);
  } catch {
    continue;
  }
  if (st.isSymbolicLink()) {
    skipped.push(`${e.name} (link)`);
    continue;
  }
  if (st.isDirectory()) {
    if (SKIP.has(e.name)) {
      skipped.push(e.name);
      continue;
    }
    const size = walk(full);
    topDirs.push({ name: `${e.name}/`, size });
    total += size;
  } else if (st.isFile()) {
    total += st.size;
    totalFiles += 1;
  }
}

topDirs.sort((a, b) => b.size - a.size);
console.log(`Worktree footprint (node_modules, .git, build output excluded):`);
console.log(`  ${mb(total)} across ${totalFiles.toLocaleString()} files`);
console.log(`  ${root}`);
console.log("");
console.log("Largest tracked directories:");
for (const d of topDirs.slice(0, 12)) {
  console.log(`  ${d.name.padEnd(28)} ${mb(d.size)}`);
}
if (skipped.length) {
  console.log("");
  console.log(`Skipped (not counted): ${skipped.join(", ")}`);
}
