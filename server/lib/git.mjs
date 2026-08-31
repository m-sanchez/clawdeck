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
