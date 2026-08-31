// @ts-check
/**
 * Lightweight masonry: packs variable-height cards into N equal columns (N grows
 * with the container width) by shortest-column placement, so columns stay
 * balanced with no row gaps. The card→column assignment is cached per
 * (columns, card-count) and reused across content refreshes, so a card keeps its
 * column on every snapshot instead of hopping when heights shift slightly.
 */

/** @type {Map<string, number[]>} `${cols}:${count}` → column index per card */
const assignments = new Map();
let resizeBound = false;

/**
 * @param {HTMLElement} container holds the cards as its direct children
 * @param {{ minCol?: number, gap?: number, maxCols?: number }} [opts]
 */
export function masonry(container, opts = {}) {
  if (!container) return;
  const minCol = opts.minCol ?? 330;
  const gap = opts.gap ?? 16;
  bindResize();

  // Source-of-truth flat card list, cached on the element so re-layouts never
  // lose cards. (Custom prop; element typing doesn't know about it.)
  const store = /** @type {{ __items?: HTMLElement[] }} */ (
    /** @type {unknown} */ (container)
  );
  const items =
    store.__items ??
    /** @type {HTMLElement[]} */ (Array.from(container.children));
  store.__items = items;
  if (!items.length) return;

  // Cap columns at the smallest of: what fits at minCol, the caller's cap, and
  // half the card count, so every column holds at least two cards and no lone
  // card gets stretched into a tall, mostly-empty box.
  const maxCols = Math.max(
    1,
    Math.min(opts.maxCols ?? 5, Math.ceil(items.length / 2)),
  );
  const width =
    container.clientWidth || container.getBoundingClientRect().width || 1200;
  const cols = Math.max(
    1,
    Math.min(maxCols, Math.floor((width + gap) / (minCol + gap))),
  );

  const columns = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < cols; i++) {
    const col = document.createElement("div");
    col.className = "masonry-col";
    columns.push(col);
    frag.append(col);
  }
  container.replaceChildren(frag);

  const key = `${cols}:${items.length}`;
  let assign = assignments.get(key);

  // First time at this width/count: measure every card at the real column width
  // (stacked in one column), then balance with longest-processing-time bin
  // packing, tallest cards placed first into the shortest column, so columns
  // end near-even instead of one blowing out. Cache the assignment for reuse.
  if (!assign || assign.length !== items.length) {
    items.forEach((item) => columns[0].append(item));
    const heights = items.map((item) => item.offsetHeight);
    const order = items
      .map((_, i) => i)
      .sort((a, b) => heights[b] - heights[a]);
    const colHeights = new Array(cols).fill(0);
    assign = new Array(items.length);
    for (const idx of order) {
      let m = 0;
      for (let c = 1; c < cols; c++) if (colHeights[c] < colHeights[m]) m = c;
      assign[idx] = m;
      colHeights[m] += heights[idx] + gap;
    }
    assignments.set(key, assign);
  }

  // Place cards into their columns, keeping each column in original card order.
  const buckets = Array.from(
    { length: cols },
    () => /** @type {number[]} */ ([]),
  );
  items.forEach((_, idx) => buckets[Math.min(assign[idx], cols - 1)].push(idx));
  for (let c = 0; c < cols; c++) {
    buckets[c].sort((a, b) => a - b);
    for (const idx of buckets[c]) columns[c].append(items[idx]);
  }
}

function bindResize() {
  if (resizeBound) return;
  resizeBound = true;
  let raf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      for (const c of document.querySelectorAll(".grid-tiles"))
        masonry(/** @type {HTMLElement} */ (c));
    });
  });
}
