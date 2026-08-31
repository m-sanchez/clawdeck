// @ts-check
/**
 * Pure routing helpers for the hub/tab router. No DOM access, so they are
 * unit-tested directly. app.mjs feeds in the hub config + alias map and reads
 * location.hash; everything route-shaped is decided here.
 */

function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Resolve a raw hash (already stripped of a leading "#/") into a route.
 * @param {string} rawHash e.g. "review/diff", "reviews", "run/runs/abc", ""
 * @param {{ hubs: Record<string, { tabs?: string[] }>, aliases: Record<string, string>, fallback: string }} cfg
 * @returns {{ hub: string, tab: string|null, id: string|null, explicitTab: boolean }}
 */
export function resolveRoute(rawHash, cfg) {
  let segs = String(rawHash || "")
    .split("/")
    .filter(Boolean);
  if (segs[0] && cfg.aliases[segs[0]]) {
    const parts = cfg.aliases[segs[0]].split("/");
    segs = [...parts, ...segs.slice(1)];
  }
  const hub = cfg.hubs[segs[0]] ? segs[0] : cfg.fallback;
  const def = cfg.hubs[hub];
  const tabs = def && def.tabs;
  if (tabs && tabs.length) {
    const explicitTab = tabs.includes(segs[1]);
    return {
      hub,
      tab: explicitTab ? segs[1] : tabs[0],
      id: segs[2] != null ? decode(segs[2]) : null,
      explicitTab,
    };
  }
  return {
    hub,
    tab: null,
    id: segs[1] != null ? decode(segs[1]) : null,
    explicitTab: false,
  };
}

/**
 * Canonical hash for a resolved route (what the address bar should show).
 * @param {string} hub @param {string|null} tab @param {string|null} id @param {boolean} hasTabs
 */
export function canonicalHash(hub, tab, id, hasTabs) {
  if (hasTabs) return id ? `#/${hub}/${tab}/${id}` : `#/${hub}/${tab}`;
  return id ? `#/${hub}/${id}` : `#/${hub}`;
}
