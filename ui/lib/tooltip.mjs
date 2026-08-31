// @ts-check
/**
 * Framework-free tooltip that mirrors the main app's ng-zorro (Ant Design v5)
 * tooltip: a bordered surface bubble with the 3-tier antd shadow, a rotated-square
 * arrow and a short fade. It is portalled to <body> and positioned with fixed
 * coordinates so it never clips inside a card, and is driven by a delegated
 * `[data-tip]` attribute, any element opts in just by setting data-tip, with no
 * per-element wiring. We cannot use nz-tooltip itself here (the panel ships no
 * Angular runtime), so this reproduces its look natively.
 */

/** @type {HTMLElement|null} */
let bubble = null;
/** @type {HTMLElement|null} */
let arrow = null;
/** @type {HTMLElement|null} */
let textNode = null;
/** @type {Element|null} */
let current = null;

const GAP = 9;
const EDGE = 8;

function ensureBubble() {
  if (bubble) return bubble;
  bubble = document.createElement("div");
  bubble.className = "panel-tip";
  bubble.setAttribute("role", "tooltip");
  textNode = document.createElement("span");
  textNode.className = "panel-tip-text";
  arrow = document.createElement("span");
  arrow.className = "panel-tip-arrow";
  bubble.append(textNode, arrow);
  document.body.append(bubble);
  return bubble;
}

function position(target) {
  if (!bubble || !arrow) return;
  const r = target.getBoundingClientRect();
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  const cx = r.left + r.width / 2;
  let top = r.top - bh - GAP;
  let bottom = false;
  if (top < EDGE) {
    top = r.bottom + GAP;
    bottom = true;
  }
  let left = cx - bw / 2;
  left = Math.max(EDGE, Math.min(left, window.innerWidth - bw - EDGE));
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
  bubble.classList.toggle("tip-bottom", bottom);
  bubble.classList.toggle("tip-top", !bottom);
  const arrowX = Math.max(12, Math.min(cx - left, bw - 12));
  arrow.style.left = `${Math.round(arrowX)}px`;
}

function show(target) {
  const tip = target.getAttribute("data-tip");
  if (!tip) return;
  current = target;
  ensureBubble();
  if (textNode) textNode.textContent = tip;
  position(target);
  bubble?.classList.add("visible");
}

function hide() {
  current = null;
  bubble?.classList.remove("visible");
}

/** @param {Event} e */
function targetOf(e) {
  const t = /** @type {Element|null} */ (e.target);
  return t && t.closest ? t.closest("[data-tip]") : null;
}

let started = false;
export function initTooltips() {
  if (started) return;
  started = true;
  document.addEventListener("pointerover", (e) => {
    const el = targetOf(e);
    if (el && el !== current) show(el);
  });
  document.addEventListener("pointerout", (e) => {
    const el = targetOf(e);
    if (el && el === current) hide();
  });
  document.addEventListener("focusin", (e) => {
    const el = targetOf(e);
    if (el) show(el);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  // The panel rebuilds view DOM on navigation/snapshot; a tooltip whose anchor was
  // removed must not linger.
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
}
