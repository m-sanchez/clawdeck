// @ts-check
import { el, card, emptyState } from "../lib/dom.mjs";

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

  return el("div", { class: "view" }, [
    el("div", { class: "cp-cards cp-cards-3" }, [
      card("Panel process", rows(proc)),
      card("Performance (recent window)", rows(perfRows)),
      card("Runtime stores", rows(stores)),
    ]),
    el("div", { class: "cp-cards cp-cards-2" }, [
      budgetCard,
      card("Observed instruction loads", observedBlock(ib.observed, root)),
    ]),
  ]);
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
