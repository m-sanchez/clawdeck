// @ts-check
/** Pure CSV helpers for exporting tabular query results. Unit-tested. */

/** True when `d` is a non-empty array of plain objects (renders as a table/CSV). */
export function isRowArray(d) {
  return (
    Array.isArray(d) &&
    d.length > 0 &&
    d.every((x) => x && typeof x === "object" && !Array.isArray(x))
  );
}

/**
 * Encode an array of objects as CSV. Header is the union of keys in first-seen
 * order; values are JSON-encoded when objects, and quoted when they contain a
 * comma, quote, or newline (RFC-4180 doubling of inner quotes).
 * @param {Record<string, unknown>[]} rows
 */
export function toCsv(rows) {
  const cols = [];
  for (const r of rows)
    for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const esc = (v) => {
    if (v == null) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.map(esc).join(",");
  const body = rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n");
  return `${head}\n${body}`;
}
