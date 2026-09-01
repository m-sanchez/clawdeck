// @ts-check
/**
 * Which fix tasks could run at the same time without fighting each other.
 *
 * The partition is mechanical: two items conflict when they touch the same
 * file, the same worktree, or the same test. There is no judgement about
 * whether the changes "feel" related, because a wrong judgement here costs a
 * merge conflict in someone else's editor.
 *
 * The overlap that caused a grouping is returned with it, so the engineer can
 * see why two items landed together rather than trusting the partition. And
 * nothing here starts anything: lanes are a proposal until a person acts.
 */

/** Files an item would plausibly touch, from evidence only. */
function filesOf(item) {
  const out = new Set();
  for (const f of item.files || []) out.add(String(f).replace(/\\/g, "/"));
  if (item.file) out.add(String(item.file).replace(/\\/g, "/"));
  return out;
}

function overlapReasons(a, b) {
  const reasons = [];
  const fa = filesOf(a);
  const shared = [...filesOf(b)].filter((f) => fa.has(f));
  if (shared.length)
    reasons.push(`same file: ${shared.slice(0, 3).join(", ")}`);
  if (a.worktree && b.worktree && a.worktree === b.worktree)
    reasons.push(`same worktree: ${a.worktree}`);
  const ta = new Set(a.tests || []);
  const sharedTests = (b.tests || []).filter((t) => ta.has(t));
  if (sharedTests.length)
    reasons.push(`same test: ${sharedTests.slice(0, 3).join(", ")}`);
  return reasons;
}

/**
 * Group items into lanes. Items in one lane conflict with each other and must
 * be done in sequence; separate lanes can proceed in parallel.
 *
 * @param {Array<{id:string, files?:string[], tests?:string[], worktree?:string|null, title?:string}>} items
 * @returns {{lanes: Array<{id:string, items:string[], reasons:string[]}>,
 *            parallelism:number, unpartitionable:string[]}}
 */
export function partitionLanes(items = []) {
  const usable = items.filter((i) => i?.id);
  // An item with no file evidence cannot be shown not to conflict, so it is
  // left out of every lane rather than guessed into one.
  const blind = usable.filter((i) => filesOf(i).size === 0).map((i) => i.id);
  const known = usable.filter((i) => filesOf(i).size > 0);

  const lanes = [];
  for (const item of known) {
    const hits = lanes.filter((lane) =>
      lane.members.some((m) => overlapReasons(m, item).length),
    );
    if (!hits.length) {
      lanes.push({ members: [item], reasons: [] });
      continue;
    }
    // Merge every lane this item touches: they are all one sequence now.
    const [first, ...rest] = hits;
    for (const m of first.members)
      first.reasons.push(
        ...overlapReasons(m, item).map((r) => `${item.id}: ${r}`),
      );
    first.members.push(item);
    for (const lane of rest) {
      first.members.push(...lane.members);
      first.reasons.push(...lane.reasons);
      lanes.splice(lanes.indexOf(lane), 1);
    }
  }

  return {
    lanes: lanes.map((lane, i) => ({
      id: `lane_${i + 1}`,
      items: lane.members.map((m) => m.id),
      reasons: [...new Set(lane.reasons)],
    })),
    parallelism: lanes.length,
    unpartitionable: blind,
  };
}
