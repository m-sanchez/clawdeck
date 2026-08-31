// @ts-check
import { el, card, emptyState, relTime } from "../lib/dom.mjs";

const LEVELS = ["all", "info", "warn", "error", "debug"];

/** Logs, live SSE event stream with filtering, pause, autoscroll and export. */
export function render(app) {
  const store = app.store;
  const sources = ["all", ...(app.snapshot?.logSources ?? [])];
  const levelSel = select(
    LEVELS,
    store.logLevel || "all",
    (v) => {
      store.logLevel = v;
      paint();
    },
    "log-level",
  );
  const sourceSel = select(
    sources,
    store.logSource || "all",
    (v) => {
      store.logSource = v;
      paint();
    },
    "log-source",
  );
  const pauseBtn = el("button", {
    class: `chip ${store.logsPaused ? "active" : ""}`,
    text: store.logsPaused ? "Paused" : "Live",
    onClick: () => {
      store.logsPaused = !store.logsPaused;
      pauseBtn.classList.toggle("active", store.logsPaused);
      pauseBtn.textContent = store.logsPaused ? "Paused" : "Live";
    },
  });
  const autoBtn = el("button", {
    class: `chip ${store.logAutoscroll !== false ? "active" : ""}`,
    text: "Autoscroll",
    onClick: () => {
      store.logAutoscroll = store.logAutoscroll === false;
      autoBtn.classList.toggle("active", store.logAutoscroll !== false);
    },
  });

  const stream = el("div", {
    class: "log-stream",
    role: "log",
    "aria-live": "polite",
  });

  function entries() {
    const live = store.recentEvents || [];
    const backlog = store.logBacklog || [];
    const all = [
      ...backlog.map((b) => ({
        level: b.level,
        message: b.message,
        source: b.source,
        emittedAt: null,
      })),
      ...live,
    ];
    const q = (store.logQuery || "").toLowerCase();
    return all.filter((e) => {
      if (
        (store.logLevel || "all") !== "all" &&
        (e.level || "info") !== store.logLevel
      )
        return false;
      if (
        (store.logSource || "all") !== "all" &&
        (e.source || e.service || "panel") !== store.logSource
      )
        return false;
      if (
        q &&
        !`${e.message || e.type || ""} ${e.source || e.service || ""}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  }

  const countEl = el("span", { class: "muted small log-count" });
  const searchInput = el("input", {
    class: "input search log-search",
    type: "search",
    name: "log-filter",
    "aria-label": "Filter logs",
    placeholder: "Filter text…",
    value: store.logQuery || "",
    oninput: (e) => {
      store.logQuery = e.target.value;
      paint();
    },
  });

  function paint() {
    const list = entries();
    stream.replaceChildren(
      ...(list.length
        ? list.slice(-800).map((e) =>
            el("div", { class: `log-line lvl-${e.level || "info"}` }, [
              el("span", {
                class: "log-time mono",
                text: e.emittedAt ? relTime(e.emittedAt) : "·",
              }),
              el("span", {
                class: "log-src mono",
                text:
                  e.source ||
                  e.service ||
                  (e.type ? e.type.split(".")[0] : "panel"),
              }),
              el("span", {
                class: "log-msg",
                text: e.message || e.type || "",
              }),
            ]),
          )
        : [
            emptyState(
              "No log lines match.",
              "Live events stream here. Run validation or an action to generate activity.",
            ),
          ]),
    );
    countEl.textContent = `${list.length} line${list.length === 1 ? "" : "s"}`;
    if (store.logAutoscroll !== false) stream.scrollTop = stream.scrollHeight;
  }

  // Let the app push new events into this view while it is mounted.
  store._onLogEvent = () => {
    if (!store.logsPaused) paint();
  };

  const controls = el("div", { class: "log-controls" }, [
    searchInput,
    el("label", { class: "inline-field" }, [
      el("span", { text: "Level" }),
      levelSel,
    ]),
    el("label", { class: "inline-field" }, [
      el("span", { text: "Source" }),
      sourceSel,
    ]),
    pauseBtn,
    autoBtn,
    el("button", {
      class: "chip",
      text: "Latest ↓",
      onClick: () => (stream.scrollTop = stream.scrollHeight),
    }),
    el("button", {
      class: "chip",
      text: "Backlog",
      onClick: () => loadBacklog(app, paint),
    }),
    el("button", {
      class: "chip",
      text: "Copy",
      onClick: () => copy(entries(), app),
    }),
    el("button", {
      class: "chip",
      text: "Download",
      onClick: () => download(entries()),
    }),
    el("button", {
      class: "chip",
      text: "Clear",
      onClick: () => {
        store.recentEvents = [];
        store.logBacklog = [];
        paint();
      },
    }),
    countEl,
  ]);

  const legend = el("div", { class: "log-legend muted small" }, [
    legendDot("info"),
    legendDot("warn"),
    legendDot("error"),
    legendDot("debug"),
  ]);

  paint();
  return el(
    "div",
    { class: "view view-logs" },
    card("Logs", [controls, legend, stream]),
  );
}

function legendDot(level) {
  return el("span", { class: "log-legend-item" }, [
    el("span", { class: `log-dot lvl-${level}` }),
    el("span", { text: level }),
  ]);
}

function select(options, value, onChange, name) {
  return el(
    "select",
    { class: "input", name, onChange: (e) => onChange(e.target.value) },
    options.map((o) =>
      el("option", { value: o, selected: o === value ? true : null, text: o }),
    ),
  );
}

async function loadBacklog(app, paint) {
  try {
    const res = await app.api.logs({ limit: 400 });
    app.store.logBacklog = res.lines || [];
    paint();
    app.toast(`Loaded ${app.store.logBacklog.length} log line(s).`, "ok");
  } catch (err) {
    app.toast(`Could not load backlog: ${err.message}`, "danger");
  }
}

function asText(list) {
  return list
    .map(
      (e) =>
        `[${e.level || "info"}] ${e.source || e.service || "panel"}  ${e.message || e.type || ""}`,
    )
    .join("\n");
}

async function copy(list, app) {
  try {
    await navigator.clipboard.writeText(asText(list));
    app.toast("Logs copied.", "ok");
  } catch {
    app.toast("Clipboard unavailable.", "warn");
  }
}

function download(list) {
  const blob = new Blob([asText(list)], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "panel-logs.txt";
  a.click();
  URL.revokeObjectURL(url);
}
