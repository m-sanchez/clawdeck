import "../clawd/clawd-element.mjs";
import { applyOcelotArtwork, ocelotIcon, OCELOT_PALETTE } from "./ocelot-art.mjs";

const states = [
  ["sleeping", "Sleeping"], ["thinking", "Thinking"], ["idle", "Idle"],
  ["reading", "Reading"], ["coding", "Working"], ["inspecting", "Inspecting"],
  ["reviewing", "Reviewing"], ["waiting", "Waiting"], ["attention", "Needs input"],
  ["blocked", "Blocked"], ["success", "Success"],
];
const variants = [
  { id: "reference", title: "Clawd", note: "The original proportions, expressions and movement.", color: "#d5982e", face: "#2a1b05" },
  { id: "continuity", title: "Continuity", note: "Amber, small ear notches, familiar geometry.", color: "#d89945", face: "#352818" },
  { id: "ocelot", title: "Ocelot", note: "Golden coat, small spot clusters and a banded tail.", color: OCELOT_PALETTE.coat, face: OCELOT_PALETTE.eye },
  { id: "signal", title: "Signal", note: "A cleaner outline with fewer details at small sizes.", color: "#889bd3", face: "#18243e" },
];
const skin = `
.assistant.clawd-assistant { --travel-start: 35px; }
.assistant-dock { display: none; }
.ocelin-ear, .ocelin-tail, .ocelin-mark { position: absolute; pointer-events: none; }
.ocelin-ear { top: -7px; width: 15px; height: 16px; z-index: 1; background: var(--brand); transform-origin: center bottom; clip-path: polygon(0 0, 5px 0, 15px 10px, 15px 16px, 0 16px); }
.ocelin-ear.left { left: 6px; }
.ocelin-ear.right { right: 6px; scale: -1 1; }
.ocelin-ear::after { content: ''; position: absolute; left: 4px; top: 5px; width: 5px; height: 7px; background: var(--brand-dark); opacity: .48; }
.ocelin-tail { z-index: 0; left: 58px; top: 25px; width: 23px; height: 27px; border-right: 7px solid var(--brand); border-bottom: 7px solid var(--brand); border-bottom-right-radius: 13px; transform-origin: left center; animation: ocelinTail 4.8s steps(4, end) infinite; }
.ocelin-tail::after { content: ''; position: absolute; right: -7px; top: 3px; width: 7px; height: 4px; background: var(--brand-dark); opacity: .4; }
.ocelin-mark { width: 5px; height: 4px; background: var(--brand-dark); opacity: .65; top: 29px; z-index: 2; }
.ocelin-mark.left { left: 8px; box-shadow: 5px 5px 0 var(--brand-dark); }
.ocelin-mark.right { right: 8px; box-shadow: -5px 5px 0 var(--brand-dark); }
:host([data-variant='continuity']) .ocelin-ear { top: -4px; height: 11px; width: 11px; }
:host([data-variant='continuity']) .ocelin-ear::after,
:host([data-variant='continuity']) .ocelin-tail,
:host([data-variant='continuity']) .ocelin-mark { display: none; }
:host([data-variant='signal']) .clawd-shell { border-radius: 10px 10px 6px 6px; clip-path: none; }
:host([data-variant='signal']) .ocelin-ear { width: 12px; top: -5px; border-radius: 3px 3px 0 0; clip-path: none; }
:host([data-variant='signal']) .ocelin-mark,
:host([data-variant='signal']) .ocelin-tail,
:host([data-variant='signal']) .ocelin-ear::after { display: none; }
:host(:not([data-variant='reference'])) .clawd-shell,
:host(:not([data-variant='reference'])) .clawd-arm,
:host(:not([data-variant='reference'])) .clawd-leg { box-shadow: inset 0 -3px 0 color-mix(in srgb, var(--brand-dark) 24%, transparent); }
.assistant[data-state='thinking'] .ocelin-ear.left { rotate: -10deg; }
.assistant[data-state='attention'] .ocelin-ear { animation: ocelinListen 2.8s steps(3, end) infinite; }
.assistant[data-state='sleeping'] .ocelin-ear.left { rotate: -16deg; }
.assistant[data-state='sleeping'] .ocelin-ear.right { rotate: 16deg; }
.assistant[data-state='blocked'] .ocelin-tail { animation: none; rotate: 18deg; }
.assistant[data-state='sleeping'] .ocelin-tail { animation: none; rotate: 12deg; }
.clawd-root.reduce-motion *, :host([data-paused]) * { animation: none !important; transition: none !important; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
@keyframes ocelinTail { 0%, 100% { rotate: 0deg; } 45% { rotate: -9deg; } 70% { rotate: 3deg; } }
@keyframes ocelinListen { 0%, 70%, 100% { translate: 0 0; } 18%, 32% { translate: 0 -2px; } }
`;

const query = (selector) => document.querySelector(selector);
let currentState = "idle";
let currentVariant = "ocelot";
const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");

function makeMascot(variantId) {
  const variant = variants.find((item) => item.id === variantId);
  const mascot = document.createElement("clawd-assistant");
  mascot.dataset.variant = variantId;
  for (const attribute of ["patrol", "bubble", "tooltip"]) mascot.setAttribute(attribute, "off");
  mascot.setAttribute("state", currentState);
  mascot.setAttribute("aria-hidden", "true");
  mascot.style.setProperty("--brand", variant.color);
  mascot.style.setProperty("--brand-dark", variant.face);
  mascot.style.setProperty("--face", variant.face);
  const style = document.createElement("style");
  style.textContent = skin;
  mascot.shadowRoot.append(style);
  if (variantId !== "reference") {
    const body = mascot.shadowRoot.querySelector(".clawd-body");
    for (const className of ["ocelin-ear left", "ocelin-ear right", "ocelin-tail", "ocelin-mark left", "ocelin-mark right"]) {
      const part = document.createElement("span");
      part.className = className;
      body.append(part);
    }
  }
  if (variantId === "ocelot") applyOcelotArtwork(mascot);
  return mascot;
}

function applyMotion() {
  const requested = query("#motion").value;
  const motion = document.hidden ? "none" : requested === "system" ? (motionQuery.matches ? "reduced" : "full") : requested;
  document.querySelectorAll("clawd-assistant").forEach((mascot) => {
    mascot.setAttribute("motion", motion);
    mascot.toggleAttribute("data-paused", document.hidden || motion === "none");
  });
}

function updateContext() {
  const variant = variants.find((item) => item.id === currentVariant);
  query("#mini").replaceChildren(makeMascot(currentVariant));
  query("#bar-title").textContent = `${variant.title} in context`;
  document.querySelectorAll(".study").forEach((card) => {
    const selected = card.dataset.variant === currentVariant;
    card.classList.toggle("selected", selected);
    const button = card.querySelector("button");
    if (button) {
      button.setAttribute("aria-pressed", String(selected));
      button.textContent = selected ? "Previewing below" : "Preview in context";
    }
  });
  const shape = currentVariant === "signal"
    ? "M2 2h3v2h6V2h3v3h1v7h-2v3h-2v-3H5v3H3v-3H1V5h1Z"
    : "M2 1h2l2 3h4l2-3h2v4h1v6h-2v4h-2v-4H9v4H7v-4H5v4H3v-4H1V5h1Z";
  query("#sizes").innerHTML = [16, 24, 32].map((size) => {
    const icon = currentVariant === "ocelot" ? ocelotIcon(size) : `<svg width="${size}" height="${size}" viewBox="0 0 16 16" role="img" aria-label="${variant.title} icon at ${size} pixels"><path d="${shape}" fill="${variant.color}"/><path d="M4 6h2v3H4zm6 0h2v3h-2z" fill="${variant.face}"/></svg>`;
    return `<div class="icon-size">${icon}<span>${size}px</span></div>`;
  }).join("");
  applyMotion();
}

for (const [state, label] of states) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.state = state;
  button.setAttribute("aria-pressed", String(state === currentState));
  button.addEventListener("click", () => {
    currentState = state;
    document.querySelectorAll("clawd-assistant").forEach((mascot) => mascot.setAttribute("state", state));
    query("#status").textContent = label;
    document.querySelectorAll("#states button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  });
  query("#states").append(button);
}

for (const [index, variant] of variants.entries()) {
  const card = document.createElement("article");
  card.className = "study";
  card.dataset.variant = variant.id;
  card.innerHTML = `<div class="study-head"><h3>${variant.title}</h3><span>${index === 0 ? "REF" : `0${index}`}</span></div><div class="stage"></div><div class="study-foot"><p>${variant.note}</p>${index === 0 ? '<span class="reference-note">Original reference</span>' : '<button type="button" aria-pressed="false">Preview in context</button>'}</div>`;
  card.querySelector(".stage").append(makeMascot(variant.id));
  card.querySelector("button")?.addEventListener("click", () => {
    currentVariant = variant.id;
    updateContext();
  });
  query("#comparison").append(card);
}

query("#appearance").addEventListener("change", (event) => {
  document.documentElement.style.colorScheme = event.target.value === "system" ? "light dark" : event.target.value;
});
query("#motion").addEventListener("change", applyMotion);
motionQuery.addEventListener("change", applyMotion);
document.addEventListener("visibilitychange", applyMotion);
updateContext();
