import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The panel's own install root — where this repository lives, never the target. */
export const PANEL_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Observed checkout: --checkout flag > PANEL_CHECKOUT_ROOT > cwd. */
export function defaultStartDir(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--checkout" && argv[i + 1]) return resolve(argv[i + 1]);
    if (argv[i].startsWith("--checkout="))
      return resolve(argv[i].slice("--checkout=".length));
  }
  if (process.env.PANEL_CHECKOUT_ROOT)
    return resolve(process.env.PANEL_CHECKOUT_ROOT);
  return process.cwd();
}

function runGit(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
}

export function findRepoRoot(start = process.cwd()) {
  const gitRoot = runGit(["rev-parse", "--show-toplevel"], start);
  if (gitRoot)
    return realpathSync.native
      ? realpathSync.native(gitRoot)
      : realpathSync(gitRoot);

  let cursor = resolve(start);
  while (true) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`Unable to locate repository root from ${start}`);
}

export function findCommonRepoRoot(checkoutRoot) {
  const commonDir = runGit(["rev-parse", "--git-common-dir"], checkoutRoot);
  if (!commonDir) return checkoutRoot;
  const absolute = isAbsolute(commonDir)
    ? commonDir
    : resolve(checkoutRoot, commonDir);
  const normalized = realpathSync.native
    ? realpathSync.native(absolute)
    : realpathSync(absolute);
  return basename(normalized) === ".git" ? dirname(normalized) : checkoutRoot;
}

export function resolvePanelContext(start = defaultStartDir()) {
  let checkoutRoot;
  let isGit = true;
  try {
    checkoutRoot = findRepoRoot(start);
  } catch {
    checkoutRoot = resolve(start);
    isGit = false;
    console.warn(
      `Not a git repository: ${checkoutRoot}. Observing it as a plain directory (git features disabled).`,
    );
  }
  const repoRoot = isGit ? findCommonRepoRoot(checkoutRoot) : checkoutRoot;
  const branch =
    runGit(["branch", "--show-current"], checkoutRoot) || undefined;
  const canonical = (
    realpathSync.native
      ? realpathSync.native(checkoutRoot)
      : realpathSync(checkoutRoot)
  ).toLowerCase();
  const hash = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 10);
  const label =
    basename(checkoutRoot)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "checkout";
  const checkoutId = `${label}-${hash}`;
  return {
    checkoutId,
    checkoutRoot,
    repoRoot,
    branch,
    isWorktree: checkoutRoot !== repoRoot,
    panelRoot: PANEL_ROOT,
  };
}
