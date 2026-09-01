// @ts-check
/**
 * Map a review's anchor line onto the current file.
 *
 * A review comment points at a line in the commit it was written against. By
 * the time we look, lines above it may have been inserted or removed, so the
 * same number now means a different line. Blaming the raw anchor line would
 * silently answer a question nobody asked - so the anchor is mapped first, from
 * the hunk headers of `diff --unified=0 <anchor>..HEAD -- <file>`, and only a
 * successfully mapped line is ever blamed.
 *
 * Pure: give it the diff text, get back what happened to that line.
 */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parsed hunk headers, oldest first. */
export function parseHunks(diffText) {
  const hunks = [];
  for (const line of String(diffText || "").split("\n")) {
    const m = HUNK.exec(line);
    if (!m) continue;
    hunks.push({
      oldStart: Number(m[1]),
      oldLines: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLines: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

/**
 * @param {string} diffText output of `diff --unified=0 <anchor>..HEAD -- <file>`
 * @param {number} anchorLine 1-based line in the anchor revision
 * @param {{ok?: boolean, renamed?: boolean}} [opts] `ok:false` when the diff
 *   command itself failed - the answer is then unknown, never "unchanged"
 * @returns {{kind: "unchanged-mapped"|"changed"|"deleted"|"unmappable"|"unknown",
 *            currentLine: number|null, offset: number|null, reasons: string[]}}
 */
export function mapAnchorLine(diffText, anchorLine, opts = {}) {
  const line = Number(anchorLine);
  if (opts.ok === false)
    return unknown("the diff against the review anchor could not be read");
  if (!Number.isInteger(line) || line < 1)
    return {
      kind: "unmappable",
      currentLine: null,
      offset: null,
      reasons: ["the review has no line anchor"],
    };
  if (opts.renamed)
    return {
      kind: "unmappable",
      currentLine: null,
      offset: null,
      reasons: ["the file was renamed since the review"],
    };

  const hunks = parseHunks(diffText);
  if (!hunks.length) {
    // No hunks for this path: the file is untouched between anchor and HEAD.
    return {
      kind: "unchanged-mapped",
      currentLine: line,
      offset: 0,
      reasons: ["the file has not changed since the review"],
    };
  }

  let offset = 0;
  for (const h of hunks) {
    const oldEnd = h.oldStart + Math.max(h.oldLines, 1) - 1;
    // A pure insertion is recorded as zero old lines at the line it follows,
    // so it can only shift the anchor, never contain it.
    const touchesAnchor =
      h.oldLines > 0 && line >= h.oldStart && line <= oldEnd;
    if (touchesAnchor) {
      if (h.newLines === 0)
        return {
          kind: "deleted",
          currentLine: null,
          offset: null,
          reasons: ["the reviewed line was removed"],
        };
      return {
        kind: "changed",
        currentLine: h.newStart,
        offset: null,
        reasons: [
          "the reviewed line is inside a range changed since the review",
        ],
      };
    }
    if (oldEnd < line || (h.oldLines === 0 && h.oldStart < line))
      offset += h.newLines - h.oldLines;
  }

  const currentLine = line + offset;
  if (currentLine < 1) return unknown("the mapped line fell outside the file");
  return {
    kind: "unchanged-mapped",
    currentLine,
    offset,
    reasons: offset
      ? [`the reviewed line moved by ${offset > 0 ? "+" : ""}${offset}`]
      : ["the reviewed line did not move"],
  };
}

function unknown(reason) {
  return {
    kind: "unknown",
    currentLine: null,
    offset: null,
    reasons: [reason],
  };
}
