// @ts-check
/**
 * Logs adapter. Reads bounded tails of this checkout's panel runtime logs
 * (`.claude/.runtime/panel/<id>/*.log`). Live workflow events are pushed over
 * SSE by the server's event hub; this provides the initial backlog. Reads are
 * size-capped so a large log never loads wholesale.
 */
import {
  existsSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";

const MAX_TAIL_BYTES = 64 * 1024;

/** Read the last ~maxBytes of a file without loading the whole thing. */
function tail(path, maxBytes = MAX_TAIL_BYTES) {
  let fd;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";
    const buf = Buffer.allocUnsafe(length);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, length, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function inferLevel(line) {
  if (/\b(error|err|fatal|throw|exception)\b/i.test(line)) return "error";
  if (/\b(warn|warning)\b/i.test(line)) return "warn";
  if (/\b(debug)\b/i.test(line)) return "debug";
  return "info";
}

/**
 * @param {{ runtimeDir: string }} ctx
 * @param {{ limit?: number, service?: string }} [opts]
 * @returns {{ source: string, level: string, message: string }[]}
 */
export function getRecentLogs(ctx, opts = {}) {
  const { runtimeDir } = ctx;
  const limit = Math.min(2000, Math.max(1, opts.limit ?? 400));
  if (!existsSync(runtimeDir)) return [];
  let files = [];
  try {
    files = readdirSync(runtimeDir).filter((f) => f.endsWith(".log"));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    const source = file.replace(/\.log$/, "");
    if (opts.service && source !== opts.service) continue;
    const text = tail(join(runtimeDir, file));
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      out.push({ source, level: inferLevel(line), message: line });
    }
  }
  return out.slice(-limit);
}

/** Distinct log sources available for filtering. */
export function getLogSources(ctx) {
  if (!existsSync(ctx.runtimeDir)) return [];
  try {
    return readdirSync(ctx.runtimeDir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => f.replace(/\.log$/, ""));
  } catch {
    return [];
  }
}
