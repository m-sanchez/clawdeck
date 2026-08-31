// @ts-check
/**
 * Recent commits on the current checkout's HEAD. Read-only `git log`, parsed into
 * structured records so the panel can show what landed lately (handy while the
 * autoloop commits). Unit-separator delimited so subjects with any punctuation
 * survive intact.
 */
import { git } from "../lib/git.mjs";

const US = "\x1f"; // field separator
const RS = "\x1e"; // record separator

/**
 * @param {{ checkoutRoot: string }} ctx
 * @param {number} [limit]
 * @returns {Promise<{ hash: string, subject: string, author: string, date: string }[]>}
 */
export async function getRecentCommits(ctx, limit = 8) {
  const n = Math.max(1, Math.min(50, Number(limit) || 8));
  const out = await git(
    [
      "log",
      `-${n}`,
      "--no-color",
      `--format=%h${US}%s${US}%an${US}%cI${RS}`,
      "HEAD",
    ],
    ctx.checkoutRoot,
  );
  if (!out) return [];
  return out
    .split(RS)
    .map((rec) => rec.replace(/^[\r\n]+/, ""))
    .filter((rec) => rec.includes(US))
    .map((rec) => {
      const [hash, subject, author, date] = rec.split(US);
      return {
        hash: (hash || "").trim(),
        subject: subject || "",
        author: author || "",
        date: date || "",
      };
    })
    .filter((c) => c.hash);
}
