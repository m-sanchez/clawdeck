// @ts-check
/**
 * <clawd-assistant>, the production Clawd. A Shadow-DOM custom element that
 * reproduces reference/clawd-playground-v16.html and is driven by typed inputs.
 * Behaviour ported from the reference: first-paint flicker protection
 * (booting → is-ready), all-props-hidden-by-default, state-entry + prop-in
 * transitions, persistent attention/blocked messages, contextual badges,
 * idle-only grounded patrol with turnaround + curiosity, reduced-motion.
 *
 * Production state comes only from the `state` attribute (set from the pure
 * derivation layer). Random cycling happens ONLY when `demo` is set.
 *
 * Props (attributes): state, message, motion (full|reduced|none), badge (""|off),
 * tooltip, patrol (""|off), speed (seconds), demo.
 */
import { CLAWD_CSS } from "./clawd.styles.mjs";

/** Contract state → reference data-state token. */
const TO_REF = { coding: "working", inspecting: "validating" };
/** Reference data-state token → contract state. */
const FROM_REF = { working: "coding", validating: "inspecting" };

/** Per-state badge glyph + default copy (reference stateData). */
const STATE_META = {
  sleeping: {
    badge: "z",
    message: "Sleeping, nothing urgent right now.",
    aria: "Sleeping assistant",
  },
  thinking: {
    badge: "?",
    message: "Thinking, weighing the next move.",
    aria: "Thinking assistant",
  },
  idle: {
    badge: "·",
    message: "Idle, keeping watch.",
    aria: "Idle assistant",
  },
  reading: {
    badge: "R",
    message: "Reading, gathering context.",
    aria: "Reading assistant",
  },
  working: {
    badge: "▶",
    message: "Coding, working through the task.",
    aria: "Coding assistant",
  },
  validating: {
    badge: "…",
    message: "Inspecting, checking the results.",
    aria: "Inspecting assistant",
  },
  reviewing: {
    badge: "✓",
    message: "Reviewing, checking the final change.",
    aria: "Reviewing assistant",
  },
  waiting: {
    badge: "…",
    message: "Waiting, an external operation is running.",
    aria: "Waiting assistant",
  },
  attention: {
    badge: "!",
    message: "Needs input, waiting on you.",
    aria: "Assistant needing attention",
  },
  blocked: {
    badge: "×",
    message: "Blocked, the workflow cannot continue.",
    aria: "Blocked assistant",
  },
  success: {
    badge: "✓",
    message: "Success, ready to ship.",
    aria: "Successful assistant",
  },
};

const CYCLE = [
  "sleeping",
  "thinking",
  "idle",
  "reading",
  "working",
  "validating",
  "reviewing",
  "waiting",
  "attention",
  "blocked",
  "success",
];
const DEMO_DURATIONS = {
  sleeping: 5600,
  thinking: 5600,
  idle: 7200,
  reading: 5900,
  working: 6000,
  validating: 5600,
  reviewing: 5600,
  waiting: 5400,
  attention: 5000,
  blocked: 5000,
  success: 4300,
};
const PERSISTENT = new Set(["attention", "blocked"]);

const TEMPLATE = `
<style>${CLAWD_CSS}
:host { --travel-duration: 36s; }
.assistant.no-patrol { animation-play-state: paused !important; left: var(--travel-start); }
.assistant.no-patrol[data-state="idle"] .clawd-stage { animation: clawdIdle 3.2s steps(2, end) infinite; }
.assistant.no-patrol[data-state="idle"] .clawd-body { animation: none; }
.assistant.no-patrol[data-state="idle"] .clawd-leg { animation: none; }
</style>
<div class="clawd-root">
  <div class="assistant-dock" aria-hidden="true"></div>
  <button class="assistant clawd-assistant priority-badges booting" type="button" data-state="sleeping" aria-label="Sleeping assistant">
    <span class="clawd-stage" aria-hidden="true">
      <span class="clawd-shadow"></span>
      <span class="clawd-body">
        <span class="clawd-arm left"></span><span class="clawd-arm right"></span>
        <span class="clawd-leg leg-1"></span><span class="clawd-leg leg-2"></span><span class="clawd-leg leg-3"></span><span class="clawd-leg leg-4"></span>
        <span class="clawd-shell"></span>
        <span class="clawd-face"><span class="clawd-eye left"></span><span class="clawd-eye right"></span></span>
        <span class="clawd-prop clawd-laptop"><span class="clawd-laptop-screen"><i></i></span><span class="clawd-laptop-base"></span></span>
        <span class="clawd-prop clawd-glass"><span class="clawd-glass-lens"></span><span class="clawd-glass-handle"></span></span>
        <span class="clawd-prop clawd-book"><span class="clawd-book-pages"></span></span>
        <span class="clawd-prop clawd-clipboard"><span class="clawd-clipboard-board"></span></span>
        <span class="clawd-prop clawd-blocked-sign">!</span>
        <span class="clawd-prop clawd-wait-dots"><span class="clawd-wait-dot"></span><span class="clawd-wait-dot"></span><span class="clawd-wait-dot"></span></span>
        <span class="clawd-prop clawd-thought"><span class="clawd-thought-dot dot-1"></span><span class="clawd-thought-dot dot-2"></span><span class="clawd-thought-cloud"><span>•••</span></span></span>
        <span class="clawd-prop clawd-sleep"><span class="clawd-z z1">z</span><span class="clawd-z z2">Z</span><span class="clawd-z z3">Z</span></span>
        <span class="clawd-particle p1"></span><span class="clawd-particle p2"></span><span class="clawd-particle p3"></span>
      </span>
      <span class="clawd-state-badge"><span class="clawd-badge-text">z</span></span>
    </span>
    <span class="assistant-status"></span>
    <span class="assistant-tooltip"></span>
  </button>
</div>`;

export class ClawdAssistant extends HTMLElement {
  static get observedAttributes() {
    return [
      "state",
      "message",
      "motion",
      "badge",
      "tooltip",
      "patrol",
      "speed",
      "demo",
      "bubble",
      "dock",
    ];
  }

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = TEMPLATE;
    const q = (/** @type {string} */ sel) =>
      /** @type {HTMLElement} */ (root.querySelector(sel));
    this._root = q(".clawd-root");
    this._assistant = q(".assistant");
    this._badge = q(".clawd-badge-text");
    this._message = q(".assistant-status");
    this._tooltip = q(".assistant-tooltip");
    this._current = "sleeping";
    /** @type {Record<string, any>} */
    this._timers = {
      message: 0,
      success: 0,
      transition: 0,
      curiosity: 0,
      curiosityEnd: 0,
      demo: 0,
    };
    this._booted = false;
  }

  connectedCallback() {
    this._assistant.addEventListener("click", () =>
      this.dispatchEvent(
        new CustomEvent("clawd-activate", { bubbles: true, composed: true }),
      ),
    );
    this._applyMotion();
    this._applyBadge();
    this._applyTooltip();
    this._applyPatrol();
    this._applySpeed();
    this._applyBubble();
    this._applyDock();
    this.setState(this.getAttribute("state") || "sleeping", { initial: true });
    // First-paint flicker protection: reveal only after a frame so no all-props
    // first frame can flash before the per-state reveal applies.
    requestAnimationFrame(() => {
      this._assistant.classList.remove("booting");
      this._assistant.classList.add("is-ready");
      this._booted = true;
    });
    if (this.hasAttribute("demo")) this._startDemo();
  }

  disconnectedCallback() {
    for (const k of Object.keys(this._timers)) clearTimeout(this._timers[k]);
  }

  attributeChangedCallback(name, _old, value) {
    if (!this.shadowRoot) return;
    switch (name) {
      case "state":
        if (!this.hasAttribute("demo")) this.setState(value || "sleeping");
        break;
      case "message":
        this._applyMessage();
        break;
      case "motion":
        this._applyMotion();
        break;
      case "badge":
        this._applyBadge();
        break;
      case "tooltip":
        this._applyTooltip();
        break;
      case "patrol":
        this._applyPatrol();
        break;
      case "speed":
        this._applySpeed();
        break;
      case "demo":
        this.hasAttribute("demo") ? this._startDemo() : this._stopDemo();
        break;
      case "bubble":
        this._applyBubble();
        break;
      case "dock":
        this._applyDock();
        break;
    }
  }

  /** Public, typed entry point. Accepts a contract state; maps internally. */
  setState(contractState, opts = {}) {
    const logical = FROM_REF[contractState] || contractState;
    const ref = TO_REF[logical] || logical;
    if (!STATE_META[ref]) return;
    const previous = this._current;
    this._current = ref;
    this._clearCuriosity();
    this._assistant.classList.remove("success-settled");
    this._assistant.dataset.state = ref;
    const meta = STATE_META[ref];
    this._badge.textContent = meta.badge;
    this._assistant.setAttribute("aria-label", meta.aria);
    this._applyMessage();
    this._applyTooltip();

    const reduced = this._root.classList.contains("reduce-motion");
    clearTimeout(this._timers.transition);
    this._assistant.classList.remove("state-enter", "waking-up");
    delete this._assistant.dataset.transition;
    if (!opts.initial && previous !== ref && !reduced) {
      this._assistant.dataset.transition = `${previous}-${ref}`;
      void this._assistant.offsetWidth;
      this._assistant.classList.add("state-enter");
      if (previous === "sleeping" && ref !== "sleeping")
        this._assistant.classList.add("waking-up");
      this._timers.transition = setTimeout(() => {
        this._assistant.classList.remove("state-enter", "waking-up");
        delete this._assistant.dataset.transition;
      }, 520);
    }

    // Message visibility: persistent for attention/blocked, brief otherwise.
    clearTimeout(this._timers.message);
    this._assistant.classList.remove("message-visible");
    void this._assistant.offsetWidth;
    if (!this._assistant.classList.contains("hide-message")) {
      this._assistant.classList.add("message-visible");
      if (!PERSISTENT.has(ref)) {
        const dur = Math.min(
          3400,
          Math.max(2500, (DEMO_DURATIONS[ref] || 5400) - 1700),
        );
        this._timers.message = setTimeout(
          () => this._assistant.classList.remove("message-visible"),
          dur,
        );
      }
    }

    // Success: one celebration, then settle into a calm happy idle.
    clearTimeout(this._timers.success);
    this._assistant.classList.remove("celebrate-once");
    if (ref === "success" && !reduced) {
      void this._assistant.offsetWidth;
      this._assistant.classList.add("celebrate-once");
      this._timers.success = setTimeout(() => {
        this._assistant.classList.remove("celebrate-once");
        if (this._current === "success")
          this._assistant.classList.add("success-settled");
      }, 1150);
    }

    if (ref === "idle") this._scheduleCuriosity();
  }

  _applyMessage() {
    const ref = this._current;
    const provided = this.getAttribute("message");
    this._message.textContent =
      provided && provided.trim() ? provided : STATE_META[ref]?.message || "";
  }

  _applyTooltip() {
    const t = this.getAttribute("tooltip");
    // tooltip="off": the panel supplies its own tooltip/status, so the built-in
    // hover bubble would just duplicate it.
    if (t === "off") {
      this._tooltip.textContent = "";
      this._tooltip.style.display = "none";
      return;
    }
    this._tooltip.style.display = "";
    this._tooltip.textContent = t && t.trim() ? t : this._message.textContent;
  }

  _applyMotion() {
    const motion = this.getAttribute("motion") || "full";
    this._root.classList.toggle("reduce-motion", motion !== "full");
    if (motion !== "full") this._clearCuriosity();
    else if (this._current === "idle") this._scheduleCuriosity();
  }

  _applyBadge() {
    // badge attribute absent or "" → show priority badges; badge="off" → hide.
    const off = this.getAttribute("badge") === "off";
    this._assistant.classList.toggle("priority-badges", !off);
    this._assistant.classList.toggle("hide-badge", off);
  }

  _applyPatrol() {
    const off = this.getAttribute("patrol") === "off";
    this._assistant.classList.toggle("no-patrol", off);
  }

  /** bubble="off" suppresses the speech/thought bubble (decorative mini clawds)
   *  and drops the inner control from the tab order, minis are mouse-only. */
  _applyBubble() {
    const off = this.getAttribute("bubble") === "off";
    this._assistant.classList.toggle("hide-message", off);
    this._assistant.tabIndex = off ? -1 : 0;
    if (off) this._assistant.classList.remove("message-visible");
    else this._applyMessage();
  }

  /** dock="off" hides the floor band so the clawd sits over scrolling content. */
  _applyDock() {
    const off = this.getAttribute("dock") === "off";
    this._root.classList.toggle("no-dock", off);
  }

  _applySpeed() {
    const s = Number(this.getAttribute("speed"));
    if (Number.isFinite(s) && s > 0)
      this.style.setProperty("--travel-duration", `${s}s`);
  }

  _scheduleCuriosity() {
    this._clearCuriosity();
    if (
      this._current !== "idle" ||
      this._root.classList.contains("reduce-motion")
    )
      return;
    this._timers.curiosity = setTimeout(() => {
      if (this._current !== "idle") return;
      this._assistant.classList.add("idle-curious");
      this._timers.curiosityEnd = setTimeout(
        () => this._assistant.classList.remove("idle-curious"),
        1080,
      );
    }, 3200);
  }

  _clearCuriosity() {
    clearTimeout(this._timers.curiosity);
    clearTimeout(this._timers.curiosityEnd);
    this._assistant.classList.remove("idle-curious");
  }

  _startDemo() {
    this._stopDemo();
    let index = Math.max(0, CYCLE.indexOf(this._current));
    const step = () => {
      index = (index + 1) % CYCLE.length;
      this.setState(CYCLE[index]);
      this._timers.demo = setTimeout(
        step,
        DEMO_DURATIONS[this._current] || 5400,
      );
    };
    this._timers.demo = setTimeout(step, DEMO_DURATIONS[this._current] || 5400);
  }

  _stopDemo() {
    clearTimeout(this._timers.demo);
  }
}

if (
  typeof customElements !== "undefined" &&
  !customElements.get("clawd-assistant")
) {
  customElements.define("clawd-assistant", ClawdAssistant);
}
