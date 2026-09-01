// @ts-check
/** Thin, injectable git runner. Arg arrays only, never a shell string. */
import { execFile } from "node:child_process";

/**
 * Run a git command and resolve its trimmed stdout, or '' on any failure.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export function git(args, cwd) {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        resolvePromise(error ? "" : String(stdout).trim());
      },
    );
  });
}

/**
 * Run a git command and resolve its exit status alongside its output.
 *
 * `git()` above collapses "empty output" and "command failed" into the same
 * empty string. Commands whose answer IS the exit code - `merge-base
 * --is-ancestor`, `rev-parse --verify`, `diff --quiet`, `cat-file -e`,
 * `ls-tree` - must use this instead, so "no" and "could not tell" stay
 * distinguishable. Never rejects.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string}>}
 */
export function gitResult(args, cwd) {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // A spawn failure (git missing) has no exit code; report null, not 0.
        const code = error
          ? typeof (/** @type {any} */ (error).code) === "number"
            ? /** @type {any} */ (error).code
            : null
          : 0;
        resolvePromise({
          ok: code === 0,
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}
