// @ts-check
import { el, card, emptyState } from "../lib/dom.mjs";
import { masonry } from "../lib/masonry.mjs";

function fmtDur(s) {
  s = Number(s) || 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
function fmtBytes(b) {
  b = Number(b) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}
function kv([k, v]) {
  return el("div", { class: "cp-kv" }, [
    el("span", { class: "muted small", text: k }),
    el("strong", { class: "mono small", text: v == null ? "·" : String(v) }),
  ]);
}
const rows = (pairs) => el("div", { class: "cp-kv-grid" }, pairs.map(kv));

/** Repo-relative path for display: drop the checkout root and normalise slashes. */
function shortPath(abs, root) {
  let p = String(abs == null ? "" : abs);
  if (root && p.startsWith(root)) p = p.slice(root.length);
  return p.replace(/^[\\/]+/, "").replace(/\\/g, "/") || String(abs || "");
}

/** Panel Health: the panel observing itself: process + runtime store sizes. */
function meterRow(label, pct, detail) {
  const tone =
    pct == null ? "neutral" : pct > 92 ? "danger" : pct > 80 ? "warn" : "ok";
  return el("div", { class: "host-meter" }, [
    el("span", { class: "host-meter-label small", text: label }),
    el(
      "div",
      {
        class: "host-meter-track",
        role: "meter",
        "aria-label": label,
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        ...(pct == null ? {} : { "aria-valuenow": String(pct) }),
      },
      [
        el("div", {
          class: `host-meter-fill tone-${tone}`,
          style: `width:${pct == null ? 0 : Math.min(100, pct)}%`,
        }),
      ],
    ),
    el("span", {
      class: "mono small",
      text: pct == null ? "n/a" : `${pct}%`,
    }),
    detail ? el("span", { class: "muted small", text: detail }) : null,
  ]);
}

function hostCard(host) {
  const h = host || {};
  return card(
    "Host",
    el("div", { class: "host-meters" }, [
      meterRow("CPU", h.cpuPct, h.cores ? `${h.cores} cores` : null),
      meterRow(
        "Memory",
        h.memUsedPct,
        h.memTotalMB
          ? `${Math.round((h.memTotalMB - (h.memFreeMB || 0)) / 1024)} / ${Math.round(h.memTotalMB / 1024)} GB`
          : null,
      ),
      meterRow(
        "Disk (checkout volume)",
        h.disk?.usedPct ?? null,
        h.disk ? `${h.disk.freeGB} GB free of ${h.disk.totalGB} GB` : null,
      ),
    ]),
    {
      help: "Machine vitals sampled with the snapshot: CPU busy since the previous sample, memory in use, and the volume holding the observed checkout. Unmeasurable values show n/a, never zero.",
    },
  );
}

export function render(app) {
  const s = app.snapshot || {};
  const p = s.panel || {};
  const proc = [
    ["Version", p.version],
    ["Node", p.node],
    ["Platform", p.platform ? `${p.platform} · ${p.cpus} cpu` : null],
    ["PID", p.pid],
    ["Port", p.port],
    ["Uptime", fmtDur(p.uptimeSec)],
    ["Memory (RSS)", p.rssMB != null ? `${p.rssMB} MB` : null],
    ["SSE clients", p.sseClients],
    ["Runtime disk", fmtBytes(p.runtimeBytes)],
    ["History points", p.historyPoints],
  ];
  const stores = [
    ["Sessions (transcript)", s.sessions?.total],
    ["Active sessions", s.sessions?.activeCount],
    ["Event-projection sessions", s.events?.count],
    ["Telemetry sessions", s.telemetry?.count],
    ["Policy sessions", s.policy?.count],
    ["Worktrees", Array.isArray(s.worktrees) ? s.worktrees.length : null],
  ];

  const pf = s.perf || {};
  const ms = (v) => (v == null ? null : `${v} ms`);
  const perfRows = [
    ["Snapshot build p50", ms(pf.snapshot?.p50)],
    ["Snapshot build p95", ms(pf.snapshot?.p95)],
    [
      "Slowest adapter",
      pf.slowestAdapter
        ? `${pf.slowestAdapter.name} (${pf.slowestAdapter.p95} ms p95)`
        : null,
    ],
    ["Ingest ok / failed", `${pf.ingest?.ok ?? 0} / ${pf.ingest?.failed ?? 0}`],
    ["Events dropped", pf.eventsDropped],
    ["SSE clients", pf.sseClients ?? p.sseClients],
  ];
  const rs = app.store.renderStats;
  if (rs) {
    perfRows.push([
      "Auto re-renders (this visit)",
      `${rs.rendered} rendered / ${rs.skipped} skipped`,
    ]);
    perfRows.push(["Last view render", ms(rs.lastMs)]);
  }

  const ib = s.instructionBudget || {};
  const root = s.checkout?.root || "";
  const baseRows = (ib.alwaysLoaded || []).map((e) => [
    e.path,
    e.estTokens != null ? `~${e.estTokens} tok` : "·",
  ]);
  baseRows.push([
    "Always-loaded total",
    ib.totalEstTokens != null ? `~${ib.totalEstTokens} tok` : "·",
  ]);
  const onDemandRows = (ib.onDemand || []).map((d) => [
    d.path,
    `${d.files} file(s)`,
  ]);

  const budgetCard = card("Instruction budget (estimated)", [
    rows(baseRows),
    onDemandRows.length
      ? el("p", {
          class: "muted small cp-subhead",
          text: "On demand (not baseline)",
        })
      : null,
    onDemandRows.length ? rows(onDemandRows) : null,
    ib.note
      ? el("p", {
          class: "muted small",
          style: "margin-top:8px",
          text: ib.note,
        })
      : null,
  ]);

  // Masonry-packed like Overview: these cards have very different heights,
  // and a fixed-column grid leaves holes under the short ones.
  const tiles = el("div", { class: "grid-tiles" }, [
    hostCard(p.host),
    card("Panel process", rows(proc)),
    card("Performance (recent window)", rows(perfRows)),
    card("Runtime stores", rows(stores)),
    budgetCard,
    card("Observed instruction loads", observedBlock(ib.observed, root)),
  ]);
  requestAnimationFrame(() => masonry(tiles));
  return el("div", { class: "view" }, [tiles]);
}

/** Real runtime evidence: the files the InstructionsLoaded hook reported loading
 *  (path + reason + memory type), distinct from the filesystem baseline. */
function observedBlock(obs, root) {
  if (!obs || !obs.fileCount) {
    return [
      emptyState(
        "No InstructionsLoaded events yet.",
        "Real load evidence appears once a session loads instructions.",
      ),
    ];
  }
  const observedRows = obs.files.map((f) => [
    shortPath(f.file, root),
    `${f.loads}×${f.loadReason ? ` · ${f.loadReason}` : ""}${
      f.memoryType ? ` · ${f.memoryType}` : ""
    }`,
  ]);
  return [
    el("p", {
      class: "muted small",
      style: "margin:0 0 8px",
      text: `${obs.fileCount} file(s), ${obs.totalLoads} load(s) · real InstructionsLoaded events`,
    }),
    el("div", { class: "cp-scroll" }, rows(observedRows)),
  ];
}
