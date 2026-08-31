// @ts-check
/**
 * Small theme-aware visualizations built on the repo's installed d3 (loaded as a
 * UMD global via /vendor/d3.js). Every chart degrades to a readable text/DOM
 * fallback when d3 is absent, so the panel never depends on the vendor asset.
 */
import { el } from "./dom.mjs";

/** @returns {any} the global d3 if the vendor bundle loaded, else null. */
function d3() {
  return /** @type {any} */ (window).d3 ?? null;
}

export function hasD3() {
  return Boolean(d3());
}

/** Resolve a theme CSS custom property to its current value. */
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

const TONE_VARS = {
  ok: "--ok",
  warn: "--warn",
  danger: "--danger",
  info: "--info",
  neutral: "--neutral",
  brand: "--brand",
};
function toneColor(tone) {
  return cssVar(TONE_VARS[tone] || "--brand", "#d5982e");
}

/**
 * Sparkline of a numeric series. `points` = number[].
 * @param {HTMLElement} container
 * @param {number[]} points
 * @param {{ height?: number, tone?: string }} [opts]
 */
export function sparkline(container, points, opts = {}) {
  const height = opts.height ?? 40;
  const tone = toneColor(opts.tone || "brand");
  container.replaceChildren();
  if (!points.length) {
    container.append(
      el("span", { class: "muted small", text: "no activity yet" }),
    );
    return;
  }
  const lib = d3();
  const width = Math.max(120, container.clientWidth || 240);
  if (!lib) {
    container.append(
      el("span", {
        class: "mono small",
        text: `▁▂▃▅▇ ${points.reduce((a, b) => a + b, 0)} events`,
      }),
    );
    return;
  }
  const max = Math.max(1, ...points);
  const x = lib
    .scaleLinear()
    .domain([0, Math.max(1, points.length - 1)])
    .range([2, width - 2]);
  const y = lib
    .scaleLinear()
    .domain([0, max])
    .range([height - 3, 3]);
  const svg = lib
    .select(container)
    .append("svg")
    .attr("width", "100%")
    .attr("height", height)
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "none");
  const area = lib
    .area()
    .x((_d, i) => x(i))
    .y0(height)
    .y1((d) => y(d))
    .curve(lib.curveMonotoneX);
  const line = lib
    .line()
    .x((_d, i) => x(i))
    .y((d) => y(d))
    .curve(lib.curveMonotoneX);
  svg
    .append("path")
    .attr("d", area(points))
    .attr("fill", tone)
    .attr("opacity", 0.14);
  svg
    .append("path")
    .attr("d", line(points))
    .attr("fill", "none")
    .attr("stroke", tone)
    .attr("stroke-width", 2)
    .attr("stroke-linejoin", "round");
}

/**
 * Multi-series line chart sharing one x-index and y-domain. Each series is a
 * named numeric array of equal length. Falls back to a compact legend with the
 * latest value per series when d3 is absent.
 * @param {HTMLElement} container
 * @param {{ label: string, points: number[], tone: string }[]} series
 * @param {{ height?: number }} [opts]
 */
export function lines(container, series, opts = {}) {
  const height = opts.height ?? 64;
  container.replaceChildren();
  const usable = series.filter((s) => s.points.length);
  if (!usable.length) {
    container.append(
      el("span", { class: "muted small", text: "no samples yet" }),
    );
    return;
  }
  const lib = d3();
  const n = Math.max(...usable.map((s) => s.points.length));
  const max = Math.max(1, ...usable.flatMap((s) => s.points));
  if (!lib) {
    container.append(
      el(
        "div",
        { class: "chart-fallback" },
        usable.map((s) =>
          el("div", { class: "kv" }, [
            el("span", { class: "k", text: s.label }),
            el("span", { class: "v", text: String(s.points.at(-1) ?? 0) }),
          ]),
        ),
      ),
    );
    return;
  }
  const width = Math.max(160, container.clientWidth || 280);
  const x = lib
    .scaleLinear()
    .domain([0, Math.max(1, n - 1)])
    .range([2, width - 2]);
  const y = lib
    .scaleLinear()
    .domain([0, max])
    .range([height - 3, 3]);
  const svg = lib
    .select(container)
    .append("svg")
    .attr("width", "100%")
    .attr("height", height)
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "none");
  for (const s of usable) {
    const line = lib
      .line()
      .x((_d, i) => x(i))
      .y((d) => y(d))
      .curve(lib.curveMonotoneX);
    svg
      .append("path")
      .attr("d", line(s.points))
      .attr("fill", "none")
      .attr("stroke", toneColor(s.tone))
      .attr("stroke-width", 2)
      .attr("stroke-linejoin", "round");
  }
}

/**
 * Donut of labelled segments with a centre total.
 * @param {HTMLElement} container
 * @param {{ label: string, value: number, tone: string }[]} segments
 * @param {{ size?: number, centerLabel?: string }} [opts]
 */
export function donut(container, segments, opts = {}) {
  const size = opts.size ?? 132;
  container.replaceChildren();
  const total = segments.reduce((a, s) => a + s.value, 0);
  const lib = d3();
  if (!lib || total === 0) {
    container.append(
      el(
        "div",
        { class: "chart-fallback" },
        segments.map((s) =>
          el("div", { class: "kv" }, [
            el("span", { class: "k", text: s.label }),
            el("span", { class: "v", text: String(s.value) }),
          ]),
        ),
      ),
    );
    return;
  }
  const r = size / 2;
  const svg = lib
    .select(container)
    .append("svg")
    .attr("width", size)
    .attr("height", size)
    .attr("viewBox", `0 0 ${size} ${size}`);
  const g = svg.append("g").attr("transform", `translate(${r},${r})`);
  const pie = lib
    .pie()
    .sort(null)
    .value((d) => d.value);
  const arc = lib
    .arc()
    .innerRadius(r - 18)
    .outerRadius(r - 2)
    .cornerRadius(2)
    .padAngle(0.02);
  g.selectAll("path")
    .data(pie(segments))
    .join("path")
    .attr("d", arc)
    .attr("fill", (d) => toneColor(d.data.tone));
  g.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "-0.1em")
    .attr("font-size", 22)
    .attr("font-weight", 800)
    .attr("fill", cssVar("--ink", "#16303f"))
    .text(String(total));
  g.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "1.3em")
    .attr("font-size", 10)
    .attr("fill", cssVar("--muted", "#5d7585"))
    .text(opts.centerLabel || "total");
}

/**
 * Horizontal bars.
 * @param {HTMLElement} container
 * @param {{ label: string, value: number, tone: string }[]} items
 */
export function bars(container, items) {
  container.replaceChildren();
  if (!items.length || items.every((i) => i.value === 0)) {
    container.append(
      el("span", { class: "muted small", text: "nothing to chart" }),
    );
    return;
  }
  const max = Math.max(1, ...items.map((i) => i.value));
  // Plain DOM bars (crisp, theme-driven, no d3 needed), robust and accessible.
  container.append(
    el(
      "div",
      { class: "bar-rows" },
      items.map((i) =>
        el("div", { class: "bar-row" }, [
          el("span", { class: "bar-label small", text: i.label }),
          el(
            "span",
            { class: "bar-track" },
            el("span", {
              class: "bar-fill",
              style: `width:${Math.round((i.value / max) * 100)}%;background:${toneColor(i.tone)}`,
            }),
          ),
          el("span", { class: "bar-value mono small", text: String(i.value) }),
        ]),
      ),
    ),
  );
}
