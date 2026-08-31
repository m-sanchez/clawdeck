// @ts-check
/**
 * Live pulse strip: the last five minutes of SSE events as 5-second buckets,
 * redrawn every second via the view ticker so activity breathes between
 * snapshots. Client-side only - it reads the arrival times the app stamps on
 * store.recentEvents, so it costs the server nothing.
 */
import { el } from "./dom.mjs";

const BUCKET_MS = 5000;
const BUCKETS = 60;

function draw(host, events, now) {
  const counts = new Array(BUCKETS).fill(0);
  const start = now - BUCKETS * BUCKET_MS;
  for (const e of events) {
    const at = e._at || 0;
    if (at < start) continue;
    const i = Math.min(BUCKETS - 1, Math.floor((at - start) / BUCKET_MS));
    counts[i]++;
  }
  const peak = Math.max(1, ...counts);
  const bars = host.querySelectorAll(".pulse-bar");
  for (let i = 0; i < BUCKETS; i++) {
    const bar = /** @type {HTMLElement} */ (bars[i]);
    if (!bar) continue;
    const h = counts[i] ? Math.max(12, (counts[i] / peak) * 100) : 4;
    bar.style.height = `${h}%`;
    bar.classList.toggle("hot", counts[i] > 0 && i >= BUCKETS - 2);
    bar.classList.toggle("on", counts[i] > 0);
  }
  const total = counts.reduce((a, b) => a + b, 0);
  const label = host.querySelector(".pulse-label");
  if (label)
    label.textContent = total
      ? `${total} event(s) · last 5m`
      : "quiet · last 5m";
}

/** @param {any} app */
export function pulseStrip(app) {
  const bars = Array.from({ length: BUCKETS }, () =>
    el("span", { class: "pulse-bar" }),
  );
  const host = el("div", { class: "pulse-strip", "aria-hidden": "true" }, [
    el("div", { class: "pulse-bars" }, bars),
    el("span", { class: "pulse-label muted small" }),
  ]);
  const tick = () => {
    if (!host.isConnected) return;
    draw(host, app.store.recentEvents || [], Date.now());
  };
  tick();
  app.store.tickers.push(tick);
  return host;
}
