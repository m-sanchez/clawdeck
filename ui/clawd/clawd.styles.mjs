// @ts-check
/**
 * Clawd geometry + animations, ported verbatim from
 * reference/clawd-playground-v16.html. Shapes, proportions, prop anchors,
 * @keyframes, overlap-protection vars, transitions and reduced-motion behaviour
 * are preserved exactly. Only the host/dock framing and the reduce-motion class
 * scope are adapted for the Shadow DOM component (`.reduce-motion` →
 * `.clawd-root.reduce-motion`). The canonical reference remains authoritative.
 */
export const CLAWD_CSS = /* css */ `
:host {
  --brand: #0a7fc7;
  --brand-dark: #075b93;
  --face: #0a2640;
  --line: #d6e0e8;
  --muted: #607789;
  display: block;
  position: relative;
  width: 100%;
  height: 124px;
  contain: layout style;
}
:host([hidden]) { display: none; }

.clawd-root {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.clawd-root.no-dock { overflow: visible; }
.clawd-root.no-dock .assistant-dock { display: none; }
/* The mascot is drawn standing on the (now hidden) dock floor, so its feet hover
   ~22px above the host's bottom. Drop it so the feet meet the bottom edge. */
.clawd-root.no-dock .assistant.clawd-assistant { bottom: -22px; }

.assistant-dock {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 36px;
  background: linear-gradient(to top, rgba(234,241,246,.98), rgba(234,241,246,.98) 20px, rgba(234,241,246,0) 20px);
  border-top: 1px solid rgba(141,163,180,.22);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.55);
  pointer-events: none;
}
.assistant-dock::before {
  content: "";
  position: absolute;
  left: 14px;
  right: 14px;
  top: 12px;
  border-top: 1px dashed rgba(126,153,176,.28);
}

.assistant.clawd-assistant {
  --travel-start: 40px;
  --travel-end: calc(100% - 200px);
  position: absolute;
  left: var(--travel-start);
  bottom: 0;
  z-index: 8;
  width: 140px;
  height: 112px;
  padding: 0;
  border: 0;
  overflow: visible;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
  --status-left: 50%;
  --status-bottom: 92px;
  --status-tail-left: 50%;
  --tooltip-left: 50%;
  --tooltip-bottom: 126px;
  animation: clawdTravel var(--travel-duration, 36s) linear infinite;
  -webkit-tap-highlight-color: transparent;
}
.assistant.clawd-assistant.booting { opacity: 0; }
.assistant.clawd-assistant.is-ready { opacity: 1; transition: opacity .08s linear; }
.assistant.clawd-assistant:focus-visible {
  outline: 3px solid rgba(0, 101, 166, .28);
  outline-offset: 4px;
  border-radius: 12px;
}

.clawd-stage {
  position: absolute;
  left: 10px;
  bottom: 0;
  width: 114px;
  height: 98px;
  transform-origin: 50% 100%;
  animation: clawdIdle 3.2s steps(2, end) infinite;
}
.clawd-shadow {
  position: absolute;
  left: 31px;
  bottom: 1px;
  width: 54px;
  height: 5px;
  background: rgba(11, 39, 62, .13);
  clip-path: polygon(5px 0, calc(100% - 5px) 0, 100% 2px, calc(100% - 5px) 100%, 5px 100%, 0 2px);
  animation: clawdShadow 1.2s steps(2, end) infinite;
}
.clawd-body {
  position: absolute;
  left: 24px;
  top: 14px;
  width: 68px;
  height: 62px;
  transform-origin: 50% 65%;
  animation: none;
}
.clawd-shell {
  position: absolute;
  inset: 0 auto auto 0;
  z-index: 2;
  width: 68px;
  height: 44px;
  background: var(--brand);
  clip-path: polygon(8px 0, 60px 0, 60px 7px, 68px 7px, 68px 37px, 60px 37px, 60px 44px, 8px 44px, 8px 37px, 0 37px, 0 7px, 8px 7px);
  box-shadow: inset 0 -4px 0 rgba(7,91,147,.28);
}
.clawd-arm, .clawd-leg {
  position: absolute;
  z-index: 1;
  display: block;
  background: var(--brand);
  box-shadow: inset 0 -3px 0 rgba(7,91,147,.28);
  transform-origin: 50% 4px;
}
.clawd-arm { top: 16px; width: 12px; height: 15px; }
.clawd-arm.left { left: -4px; transform: translateY(2px) rotate(12deg); }
.clawd-arm.right { right: -4px; transform: translateY(2px) rotate(-12deg); }
.clawd-leg { top: 39px; width: 8px; height: 19px; }
.clawd-leg.leg-1 { left: 10px; transform: translateY(0) rotate(2deg); }
.clawd-leg.leg-2 { left: 24px; transform: translateY(0) rotate(-2deg); }
.clawd-leg.leg-3 { right: 24px; transform: translateY(0) rotate(2deg); }
.clawd-leg.leg-4 { right: 10px; transform: translateY(0) rotate(-2deg); }

.clawd-face { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
.clawd-eye {
  position: absolute;
  top: 14px;
  width: 8px;
  height: 12px;
  background: var(--face);
  border-radius: 1px;
  transform-origin: 50% 50%;
  translate: 0 0;
  scale: 1 1;
  animation: clawdLook 6s steps(1, end) infinite, clawdBlink 5s steps(1, end) infinite;
}
.clawd-eye.left { left: 17px; }
.clawd-eye.right { right: 17px; animation-delay: 0s, .04s; }

.clawd-prop {
  position: absolute;
  z-index: 4;
  opacity: 0;
  transition: opacity .1s linear;
  pointer-events: none;
}

.clawd-laptop { left: 1px; top: 22px; width: 66px; height: 44px; transform-origin: 50% 100%; }
.clawd-laptop-screen {
  position: absolute; left: 12px; top: 0; width: 34px; height: 22px;
  background: #eef7ff; border: 3px solid var(--face); box-shadow: inset 0 0 0 2px rgba(10, 127, 199, .10);
}
.clawd-laptop-screen::before {
  content: "</>"; position: absolute; left: 4px; top: 4px; color: rgba(10,127,199,.55);
  font: 900 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: -.08em;
}
.clawd-laptop-screen::after {
  content: ""; position: absolute; left: 6px; top: 13px; width: 16px; height: 2px;
  background: rgba(10,127,199,.28); box-shadow: 0 5px 0 rgba(10,127,199,.18);
}
.clawd-laptop-screen i {
  position: absolute; right: 5px; top: 4px; width: 2px; height: 8px; background: rgba(10,38,64,.42); opacity: 0;
}
.clawd-laptop-base {
  position: absolute; left: 0; top: 23px; width: 56px; height: 11px; background: #b2daf4;
  border-top: 3px solid var(--face); clip-path: polygon(4px 0, calc(100% - 4px) 0, 100% 100%, 0 100%);
  box-shadow: inset 0 -2px 0 rgba(7,91,147,.15);
}
.clawd-laptop-base::after {
  content: ""; position: absolute; left: 8px; top: 3px; width: 40px; height: 5px;
  background-image: radial-gradient(circle, rgba(10,38,64,.45) 1px, transparent 1.2px);
  background-size: 6px 5px; background-position: 0 0; opacity: .6;
}

.clawd-glass { right: -3px; top: 11px; width: 28px; height: 30px; transform-origin: 50% 80%; }
.clawd-glass-lens {
  position: absolute; left: 0; top: 0; width: 16px; height: 16px; border: 4px solid var(--face);
  background: rgba(232,244,255,.85); box-shadow: inset 0 0 0 2px rgba(10,127,199,.14); overflow: hidden;
}
.clawd-glass-lens::after {
  content: ""; position: absolute; left: -8px; top: 1px; width: 6px; height: 10px;
  background: rgba(255,255,255,.62); transform: rotate(20deg); opacity: 0;
}
.clawd-glass-handle {
  position: absolute; left: 14px; top: 12px; width: 4px; height: 16px; background: var(--face);
  transform: rotate(-42deg); transform-origin: top center;
}

.clawd-thought { left: 71px; top: -26px; width: 42px; height: 34px; animation: clawdThoughtFloat 2.3s steps(3, end) infinite; }
.clawd-thought-dot, .clawd-thought-cloud { position: absolute; background: #ffffff; border: 3px solid var(--face); }
.clawd-thought-dot.dot-1 { left: 2px; top: 26px; width: 5px; height: 5px; border-radius: 50%; }
.clawd-thought-dot.dot-2 { left: 10px; top: 18px; width: 8px; height: 8px; border-radius: 50%; }
.clawd-thought-cloud {
  left: 18px; top: 2px; width: 24px; height: 18px; display: grid; place-items: center; border-radius: 999px;
  box-shadow: inset 0 -2px 0 rgba(10,127,199,.08);
}
.clawd-thought-cloud::before, .clawd-thought-cloud::after { display: none; }
.clawd-thought-cloud span {
  position: static; color: var(--face); font: 900 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .08em; transform: translateY(-1px);
}

.clawd-sleep { left: 74px; top: -14px; width: 26px; height: 24px; }
.clawd-z { position: absolute; color: var(--face); font: 900 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; opacity: 0; }
.clawd-z.z1 { left: 2px; top: 12px; font-size: 10px; }
.clawd-z.z2 { left: 10px; top: 5px; font-size: 12px; }
.clawd-z.z3 { left: 18px; top: 0; font-size: 14px; }

.clawd-book {
  left: 10px; top: 30px; width: 50px; height: 29px; background: var(--face);
  clip-path: polygon(0 6px, 19px 1px, 25px 5px, 31px 1px, 50px 6px, 47px 28px, 31px 23px, 25px 27px, 19px 23px, 3px 28px);
  filter: drop-shadow(0 2px 0 rgba(7,91,147,.12));
}
.clawd-book-pages {
  position: absolute; left: 3px; top: 3px; width: 44px; height: 23px;
  background:
    linear-gradient(rgba(10,127,199,.24), rgba(10,127,199,.24)) 7px 7px / 10px 2px no-repeat,
    linear-gradient(rgba(10,127,199,.16), rgba(10,127,199,.16)) 6px 12px / 11px 2px no-repeat,
    linear-gradient(rgba(10,127,199,.11), rgba(10,127,199,.11)) 7px 17px / 9px 2px no-repeat,
    linear-gradient(rgba(10,127,199,.24), rgba(10,127,199,.24)) 27px 7px / 10px 2px no-repeat,
    linear-gradient(rgba(10,127,199,.16), rgba(10,127,199,.16)) 27px 12px / 11px 2px no-repeat,
    linear-gradient(rgba(10,127,199,.11), rgba(10,127,199,.11)) 28px 17px / 9px 2px no-repeat,
    #f9fcff;
  clip-path: polygon(0 4px, 16px 0, 22px 4px, 28px 0, 44px 4px, 42px 21px, 28px 18px, 22px 21px, 16px 18px, 2px 21px);
  box-shadow: inset 0 -2px 0 rgba(10,127,199,.08);
}
.clawd-book-pages::after {
  content: ""; position: absolute; left: 21px; top: 3px; width: 2px; height: 17px;
  background: rgba(10,38,64,.48); transform: skewY(-8deg);
}
.clawd-book-pages::before {
  content: ""; position: absolute; right: 4px; top: 4px; width: 6px; height: 8px;
  border-top: 1px solid rgba(10,38,64,.16); transform: skewY(12deg); opacity: .55;
}

.clawd-clipboard { left: 3px; top: 22px; width: 34px; height: 38px; transform-origin: 50% 80%; }
.clawd-clipboard-board {
  position: absolute; inset: 4px 0 0; background: #f9fcff; border: 3px solid var(--face); box-shadow: inset 0 -2px 0 rgba(10,127,199,.08);
}
.clawd-clipboard-board::before {
  content: ""; position: absolute; left: 7px; top: -7px; width: 14px; height: 7px; background: #b2daf4; border: 3px solid var(--face);
}
.clawd-clipboard-board::after {
  content: "✓"; position: absolute; left: 8px; top: 6px; color: #238a4b;
  font: 900 14px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-shadow: 0 8px 0 rgba(10,127,199,.22);
}

.clawd-blocked-sign {
  right: -16px; top: 7px; width: 28px; height: 28px; display: grid; place-items: center; color: #fff;
  background: #d94c4c; border: 3px solid var(--face); font: 900 16px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  box-shadow: 0 3px 0 rgba(83,30,30,.14);
}

.clawd-wait-dots {
  right: -18px; top: 7px; width: 30px; height: 18px; display: flex; align-items: center; justify-content: center;
  gap: 3px; padding: 4px; background: rgba(255,255,255,.96); border: 3px solid var(--face); border-radius: 8px;
  box-shadow: 0 2px 0 rgba(7,91,147,.12);
}
.clawd-wait-dot { width: 4px; height: 4px; background: var(--brand); border-radius: 1px; opacity: .28; }

.clawd-state-badge {
  position: absolute; right: 2px; top: 1px; z-index: 5; min-width: 24px; height: 24px; display: grid; place-items: center;
  padding: 0 5px; border: 2px solid #fff; border-radius: 5px; color: #fff; background: var(--brand);
  box-shadow: 0 3px 0 rgba(31,55,74,.10); font: 800 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0; transform: translateY(2px) scale(.94); transition: opacity .15s ease, transform .15s ease;
}

.assistant-status {
  position: absolute; left: var(--status-left); bottom: var(--status-bottom); z-index: 8; translate: -50% 0;
  width: max-content; max-width: 190px; padding: 7px 10px; border: 1px solid #d9e1e7; border-radius: 8px 8px 8px 4px;
  color: #365064; background: rgba(255,255,255,.98); box-shadow: 0 6px 16px rgba(38,60,77,.10);
  font-size: 9px; font-weight: 750; letter-spacing: .01em; white-space: normal; text-align: center; line-height: 1.25;
  pointer-events: none; opacity: 0; transform: translateY(4px);
  transition: opacity .18s ease, transform .18s ease, translate .18s ease;
}
.assistant-status::after {
  content: ""; position: absolute; left: var(--status-tail-left); bottom: -5px; width: 8px; height: 8px;
  background: rgba(255,255,255,.98); border-right: 1px solid #d9e1e7; border-bottom: 1px solid #d9e1e7;
  transform: translateX(-50%) rotate(45deg);
}
.assistant.message-visible .assistant-status,
.assistant[data-state="attention"] .assistant-status,
.assistant[data-state="blocked"] .assistant-status,
.assistant:hover .assistant-status,
.assistant:focus-visible .assistant-status { opacity: 1; transform: translateY(0); }

.assistant.priority-badges[data-state="attention"] .clawd-state-badge,
.assistant.priority-badges[data-state="blocked"] .clawd-state-badge,
.assistant.priority-badges[data-state="success"] .clawd-state-badge { opacity: 1; transform: translateY(0) scale(1); }

.assistant[data-state="thinking"],
.assistant[data-state="working"],
.assistant[data-state="validating"],
.assistant[data-state="reading"],
.assistant[data-state="reviewing"] {
  --status-left: 24%; --status-bottom: 88px; --status-tail-left: 72%; --tooltip-left: 24%; --tooltip-bottom: 122px;
}
.assistant[data-state="thinking"] {
  --status-left: 20%; --status-bottom: 84px; --status-tail-left: 78%; --tooltip-left: 20%; --tooltip-bottom: 118px;
}
.assistant[data-state="reading"] { --status-left: 26%; --status-tail-left: 70%; }
.assistant[data-state="reviewing"] { --status-left: 28%; --status-tail-left: 68%; }
.assistant[data-state="thinking"] .assistant-status,
.assistant[data-state="working"] .assistant-status,
.assistant[data-state="validating"] .assistant-status,
.assistant[data-state="reading"] .assistant-status,
.assistant[data-state="reviewing"] .assistant-status { max-width: 156px; }
.assistant[data-state="thinking"] .assistant-status { bottom: 82px; }

.assistant[data-state="thinking"] .clawd-shadow,
.assistant[data-state="reading"] .clawd-shadow,
.assistant[data-state="working"] .clawd-shadow,
.assistant[data-state="validating"] .clawd-shadow,
.assistant[data-state="reviewing"] .clawd-shadow,
.assistant[data-state="waiting"] .clawd-shadow {
  width: 56px; left: 30px; opacity: .13; animation: clawdStaticShadow 2.8s steps(2, end) infinite;
}
.assistant[data-state="blocked"] .clawd-shadow { width: 62px; left: 27px; opacity: .17; }

.assistant-tooltip {
  position: absolute; left: var(--tooltip-left); bottom: var(--tooltip-bottom); translate: -50% 0; max-width: 220px;
  padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.98);
  box-shadow: 0 6px 18px rgba(38,60,77,.09); color: var(--muted); font-size: 10px; line-height: 1.35;
  opacity: 0; pointer-events: none; transition: opacity .16s ease;
}
.assistant:hover .assistant-tooltip, .assistant:focus-visible .assistant-tooltip { opacity: 1; }

.clawd-particle { position: absolute; z-index: 4; width: 5px; height: 5px; opacity: 0; background: var(--brand); }
.clawd-particle.p1 { left: -4px; top: 3px; }
.clawd-particle.p2 { right: -2px; top: 8px; }
.clawd-particle.p3 { right: 9px; top: -7px; }

.assistant[data-state="attention"] .clawd-stage { animation: clawdAttention 1.95s steps(2, end) infinite; }
.assistant[data-state="attention"] .clawd-state-badge { background: #d78913; }
.assistant[data-state="attention"] .clawd-eye { top: 14px; height: 14px; animation: clawdAlertLook 2.6s steps(2, end) infinite, clawdAlertBlink 2.9s steps(1, end) infinite; }
.assistant[data-state="attention"] .clawd-arm.left { transform: translate(-1px, -2px) rotate(40deg); }
.assistant[data-state="attention"] .clawd-arm.right { transform: translate(1px, -4px) rotate(-56deg); animation: clawdAttentionWave 3.8s steps(5, end) infinite; }
.assistant[data-state="attention"] .clawd-leg { animation: none; }

.assistant[data-state="working"] .clawd-stage { animation: clawdWorking .92s steps(3, end) infinite; }
.assistant[data-state="working"] .clawd-eye { animation: clawdCodeLook 2.4s steps(4, end) infinite, clawdBlink 4.2s steps(1, end) infinite; }
.assistant[data-state="working"] .clawd-arm.left { animation: clawdTypeLeft 1.6s steps(6, end) infinite; }
.assistant[data-state="working"] .clawd-arm.right { animation: clawdTypeRight 1.6s steps(6, end) infinite; }
.assistant[data-state="working"] .clawd-leg.leg-1, .assistant[data-state="working"] .clawd-leg.leg-4 { transform: translateY(1px); }
.assistant[data-state="working"] .clawd-laptop { opacity: 1; transform: translate(0, 1px); }
.assistant[data-state="working"] .clawd-laptop-screen i { opacity: 1; animation: clawdCursorBlink 1s steps(2, end) infinite; }
.assistant[data-state="working"] .clawd-laptop-screen::after { animation: clawdCodeLines 2.4s steps(6, end) infinite; }

.assistant[data-state="validating"] .clawd-stage { animation: clawdValidate 1.4s steps(3, end) infinite; }
.assistant[data-state="validating"] .clawd-state-badge { background: #6957d6; }
.assistant[data-state="validating"] .clawd-eye { top: 18px; height: 8px; animation: clawdScan 1.15s steps(3, end) infinite, clawdBlink 4.3s steps(1, end) infinite; }
.assistant[data-state="validating"] .clawd-arm.left { transform: translate(1px, 4px) rotate(22deg); }
.assistant[data-state="validating"] .clawd-arm.right { transform: translate(-4px, 7px) rotate(-68deg); animation: clawdInspectHand 2.8s steps(5, end) infinite; }
.assistant[data-state="validating"] .clawd-shell { transform: translateY(1px); }
.assistant[data-state="validating"] .clawd-leg.leg-1, .assistant[data-state="validating"] .clawd-leg.leg-4 { transform: translateY(1px); }
.assistant[data-state="validating"] .clawd-glass { opacity: 1; transform: translate(-1px, -2px) rotate(-4deg); animation: clawdInspectGlass 2.8s steps(5, end) infinite; }
.assistant[data-state="validating"] .clawd-glass-lens::after { opacity: 1; animation: clawdLensSweep 1.4s steps(4, end) infinite; }

.assistant[data-state="thinking"] .clawd-stage { animation: clawdThink 2.3s steps(3, end) infinite; }
.assistant[data-state="thinking"] .clawd-state-badge { background: #5a8fb6; }
.assistant[data-state="thinking"] .clawd-shell { transform: rotate(-2deg) translateY(1px); }
.assistant[data-state="thinking"] .clawd-face { transform: translateY(-1px); }
.assistant[data-state="thinking"] .clawd-eye { top: 13px; height: 11px; animation: clawdThinkLook 2.3s steps(3, end) infinite, clawdBlink 4.8s steps(1, end) infinite; }
.assistant[data-state="thinking"] .clawd-arm.left { transform: translate(0, 4px) rotate(22deg); }
.assistant[data-state="thinking"] .clawd-arm.right { transform: translate(-3px, 8px) rotate(-92deg); }
.assistant[data-state="thinking"] .clawd-leg.leg-1, .assistant[data-state="thinking"] .clawd-leg.leg-4 { transform: translateY(1px); }
.assistant[data-state="thinking"] .clawd-thought { opacity: 1; }

.assistant[data-state="reading"] .clawd-stage { animation: clawdRead 1.8s steps(3, end) infinite; }
.assistant[data-state="reading"] .clawd-state-badge { background: #4b82a8; }
.assistant[data-state="reading"] .clawd-eye { top: 18px; height: 9px; animation: clawdReadEyes 1.8s steps(3, end) infinite, clawdBlink 5s steps(1, end) infinite; }
.assistant[data-state="reading"] .clawd-arm.left { transform: translate(8px, 10px) rotate(74deg); }
.assistant[data-state="reading"] .clawd-arm.right { transform: translate(-8px, 10px) rotate(-74deg); }
.assistant[data-state="reading"] .clawd-book { opacity: 1; animation: clawdPageTurn 4.4s steps(7, end) infinite; }
.assistant[data-state="reading"] .clawd-book-pages::before { animation: clawdPageCorner 4.4s steps(7, end) infinite; }
.assistant[data-state="reading"] .clawd-leg.leg-1, .assistant[data-state="reading"] .clawd-leg.leg-4 { transform: translateY(1px); }

.assistant[data-state="reviewing"] .clawd-stage { animation: clawdReview 3.2s steps(6, end) infinite; }
.assistant[data-state="reviewing"] .clawd-state-badge { background: #357b6d; }
.assistant[data-state="reviewing"] .clawd-eye { top: 17px; height: 9px; animation: clawdReviewEyes 2.2s steps(4, end) infinite, clawdBlink 4.6s steps(1, end) infinite; }
.assistant[data-state="reviewing"] .clawd-arm.left { transform: translate(7px, 9px) rotate(72deg); }
.assistant[data-state="reviewing"] .clawd-arm.right { transform: translate(-20px, 8px) rotate(-72deg); }
.assistant[data-state="reviewing"] .clawd-clipboard { opacity: 1; transform: translate(0, 0); animation: clawdClipboardPulse 3.2s steps(6, end) infinite; }
.assistant[data-state="reviewing"] .clawd-clipboard-board::after { animation: clawdCheckPulse 3.2s steps(6, end) infinite; }
.assistant[data-state="reviewing"] .clawd-leg.leg-2, .assistant[data-state="reviewing"] .clawd-leg.leg-3 { transform: translateY(1px); }

.assistant[data-state="waiting"] .clawd-stage { animation: clawdWaiting 3.4s steps(5, end) infinite; }
.assistant[data-state="waiting"] .clawd-eye { top: 16px; height: 10px; animation: clawdWaitingEyes 3.4s steps(5, end) infinite, clawdBlink 5.2s steps(1, end) infinite; }
.assistant[data-state="waiting"] .clawd-arm.left { transform: translateY(4px) rotate(8deg); }
.assistant[data-state="waiting"] .clawd-arm.right { transform: translateY(4px) rotate(-8deg); }
.assistant[data-state="waiting"] .clawd-leg.leg-2, .assistant[data-state="waiting"] .clawd-leg.leg-3 { transform: translateY(1px); }
.assistant[data-state="waiting"] .clawd-wait-dots { opacity: 1; transform: translate(0, -1px); }
.assistant[data-state="waiting"] .clawd-wait-dot:nth-child(1) { animation: clawdWaitDot 1.2s steps(3, end) infinite; }
.assistant[data-state="waiting"] .clawd-wait-dot:nth-child(2) { animation: clawdWaitDot 1.2s steps(3, end) .2s infinite; }
.assistant[data-state="waiting"] .clawd-wait-dot:nth-child(3) { animation: clawdWaitDot 1.2s steps(3, end) .4s infinite; }

.assistant[data-state="blocked"] .clawd-stage { animation: clawdBlocked 2.2s steps(4, end) infinite; }
.assistant[data-state="blocked"] .clawd-state-badge { background: #d94c4c; }
.assistant[data-state="blocked"] .clawd-eye { top: 21px; width: 10px; height: 3px; animation: none; }
.assistant[data-state="blocked"] .clawd-arm.left { transform: translateY(7px) rotate(8deg); }
.assistant[data-state="blocked"] .clawd-arm.right { transform: translateY(7px) rotate(-8deg); }
.assistant[data-state="blocked"] .clawd-body { translate: 0 2px; }
.assistant[data-state="blocked"] .clawd-blocked-sign { opacity: 1; animation: clawdBlockedWobble 4.2s steps(7, end) infinite; }

.assistant[data-state="sleeping"] .clawd-stage { animation: clawdSleep 3.2s steps(2, end) infinite; }
.assistant[data-state="sleeping"] .clawd-state-badge { background: #8798a6; }
.assistant[data-state="sleeping"] .clawd-eye { top: 23px; width: 9px; height: 3px; animation: none; }
.assistant[data-state="sleeping"] .clawd-eye.left { transform: rotate(4deg); }
.assistant[data-state="sleeping"] .clawd-eye.right { transform: rotate(-4deg); }
.assistant[data-state="sleeping"] .clawd-arm.left { transform: translateY(7px) rotate(6deg); }
.assistant[data-state="sleeping"] .clawd-arm.right { transform: translateY(7px) rotate(-6deg); }
.assistant[data-state="sleeping"] .clawd-body { translate: 0 4px; }
.assistant[data-state="sleeping"] .clawd-shadow { width: 60px; opacity: .16; }
.assistant[data-state="sleeping"] .clawd-leg.leg-1,
.assistant[data-state="sleeping"] .clawd-leg.leg-2,
.assistant[data-state="sleeping"] .clawd-leg.leg-3,
.assistant[data-state="sleeping"] .clawd-leg.leg-4 { transform: translateY(3px); }
.assistant[data-state="sleeping"] .clawd-sleep { opacity: 1; }
.assistant[data-state="sleeping"] .clawd-z { animation: clawdZ 2s steps(2, end) infinite; }
.assistant[data-state="sleeping"] .clawd-z.z2 { animation-delay: .35s; }
.assistant[data-state="sleeping"] .clawd-z.z3 { animation-delay: .7s; }

.assistant[data-state="success"] .clawd-stage { animation: none; }
.assistant[data-state="success"].celebrate-once .clawd-stage { animation: clawdSuccess 1.05s steps(3, end) 1; }
.assistant[data-state="success"] .clawd-state-badge { background: #238a4b; }
.assistant[data-state="success"] .clawd-eye { top: 20px; width: 10px; height: 3px; animation: none; }
.assistant[data-state="success"] .clawd-eye.left { transform: rotate(10deg); }
.assistant[data-state="success"] .clawd-eye.right { transform: rotate(-10deg); }
.assistant[data-state="success"] .clawd-arm.left { transform: translate(1px, -7px) rotate(68deg); }
.assistant[data-state="success"] .clawd-arm.right { transform: translate(-1px, -7px) rotate(-68deg); }
.assistant[data-state="success"] .clawd-leg.leg-1,
.assistant[data-state="success"] .clawd-leg.leg-2,
.assistant[data-state="success"] .clawd-leg.leg-3,
.assistant[data-state="success"] .clawd-leg.leg-4 { transform: translateY(-1px); }
.assistant[data-state="success"].celebrate-once .clawd-particle { opacity: 1; animation: clawdConfetti 1.05s steps(3, end) 1; }
.assistant[data-state="success"] .clawd-particle.p2 { animation-delay: .14s; }
.assistant[data-state="success"] .clawd-particle.p3 { animation-delay: .28s; }

.assistant[data-state="idle"] .clawd-stage { animation: clawdIdleWalk 1.04s steps(4, end) infinite, clawdTurnPause var(--travel-duration, 36s) linear infinite; }
.assistant[data-state="idle"] .clawd-body { animation: clawdDirection var(--travel-duration, 36s) steps(1, end) infinite; }
.assistant[data-state="idle"] .clawd-eye.left { animation: clawdLook 6s steps(1, end) infinite, clawdIdleBlink 7.4s steps(1, end) infinite, clawdTurnLook var(--travel-duration, 36s) linear infinite; }
.assistant[data-state="idle"] .clawd-eye.right { animation: clawdLook 6s steps(1, end) infinite, clawdIdleBlink 7.4s steps(1, end) .04s infinite, clawdTurnLook var(--travel-duration, 36s) linear infinite; }
.assistant[data-state="idle"] .clawd-state-badge { background: #6f8291; }
.assistant[data-state="idle"] .clawd-shadow { animation: clawdIdleShadow 1.02s steps(4, end) infinite; }
.assistant[data-state="idle"] .clawd-arm.left { animation: clawdIdleArmLeft 1.02s steps(4, end) infinite; }
.assistant[data-state="idle"] .clawd-arm.right { animation: clawdIdleArmRight 1.02s steps(4, end) infinite; }
.assistant[data-state="idle"] .clawd-leg.leg-1, .assistant[data-state="idle"] .clawd-leg.leg-3 { animation: clawdIdleLegA 1.02s steps(4, end) infinite; }
.assistant[data-state="idle"] .clawd-leg.leg-2, .assistant[data-state="idle"] .clawd-leg.leg-4 { animation: clawdIdleLegB 1.02s steps(4, end) infinite; }

.assistant.state-enter .clawd-stage { animation: clawdStateEnter .34s steps(3, end) 1 !important; }
.assistant.state-enter .clawd-prop { animation: none; }
.assistant.state-enter[data-state="sleeping"] .clawd-sleep,
.assistant.state-enter[data-state="thinking"] .clawd-thought,
.assistant.state-enter[data-state="reading"] .clawd-book,
.assistant.state-enter[data-state="working"] .clawd-laptop,
.assistant.state-enter[data-state="validating"] .clawd-glass,
.assistant.state-enter[data-state="reviewing"] .clawd-clipboard,
.assistant.state-enter[data-state="blocked"] .clawd-blocked-sign,
.assistant.state-enter[data-state="waiting"] .clawd-wait-dots { animation: clawdPropIn .24s steps(2, end) 1 both; }
.assistant.waking-up .clawd-stage { animation: clawdWake .42s steps(3, end) 1 !important; }

.assistant[data-transition="sleeping-idle"][data-state="idle"] .clawd-stage { animation: clawdWakeToWalk .56s steps(4, end) 1 !important; }
.assistant[data-transition="reading-working"][data-state="working"] .clawd-laptop,
.assistant[data-transition="thinking-working"][data-state="working"] .clawd-laptop { animation: clawdLaptopIn .3s steps(3, end) 1 both; }
.assistant[data-transition="working-validating"][data-state="validating"] .clawd-glass { animation: clawdGlassLift .3s steps(3, end) 1 both; }
.assistant[data-transition="validating-reviewing"][data-state="reviewing"] .clawd-clipboard { animation: clawdClipboardIn .3s steps(3, end) 1 both; }
.assistant[data-transition="reviewing-success"][data-state="success"] .clawd-stage { animation: clawdSuccessEntry .95s steps(4, end) 1 !important; }
.assistant[data-transition="waiting-attention"][data-state="attention"] .clawd-arm.right { animation: clawdAttentionEntry .38s steps(3, end) 1, clawdAttentionWave 1.1s steps(3, end) .38s infinite; }

.assistant[data-state="idle"]:hover, .assistant[data-state="idle"]:focus-visible,
.assistant[data-state="idle"]:hover .clawd-stage, .assistant[data-state="idle"]:focus-visible .clawd-stage,
.assistant[data-state="idle"]:hover .clawd-body, .assistant[data-state="idle"]:focus-visible .clawd-body,
.assistant[data-state="idle"]:hover .clawd-shadow, .assistant[data-state="idle"]:focus-visible .clawd-shadow,
.assistant[data-state="idle"]:hover .clawd-eye, .assistant[data-state="idle"]:focus-visible .clawd-eye,
.assistant[data-state="idle"]:hover .clawd-arm, .assistant[data-state="idle"]:focus-visible .clawd-arm,
.assistant[data-state="idle"]:hover .clawd-leg, .assistant[data-state="idle"]:focus-visible .clawd-leg { animation-play-state: paused !important; }

.assistant.idle-curious { animation-play-state: paused !important; }
.assistant.idle-curious .clawd-stage { animation: clawdCuriousPause 1.05s steps(4, end) 1 forwards !important; }
.assistant.idle-curious .clawd-eye { animation: clawdCuriousEyes 1.05s steps(4, end) 1 forwards !important; }
.assistant.idle-curious .clawd-arm.left { transform: translateY(2px) rotate(4deg); }
.assistant.idle-curious .clawd-arm.right { transform: translateY(2px) rotate(-4deg); }
.assistant.idle-curious .clawd-leg { animation: none !important; transform: translateY(1px) !important; }

.assistant[data-state="success"].success-settled .clawd-arm.left { transform: translate(0, -1px) rotate(18deg); }
.assistant[data-state="success"].success-settled .clawd-arm.right { transform: translate(0, -1px) rotate(-18deg); }
.assistant[data-state="success"].success-settled .clawd-leg { transform: translateY(1px); }
.assistant[data-state="success"].success-settled .clawd-stage { animation: clawdHappySettle 3.2s steps(4, end) infinite; }
.assistant[data-state="success"].success-settled .clawd-shadow { width: 58px; opacity: .13; }

.assistant.hide-badge .clawd-state-badge,
.assistant.hide-message .assistant-status,
.assistant.hide-message .assistant-status::after,
.assistant.hide-tooltip .assistant-tooltip { display: none; }

.assistant[data-state="sleeping"],
.assistant[data-state="thinking"],
.assistant[data-state="reading"],
.assistant[data-state="working"],
.assistant[data-state="validating"],
.assistant[data-state="reviewing"],
.assistant[data-state="waiting"],
.assistant[data-state="attention"],
.assistant[data-state="blocked"],
.assistant[data-state="success"] { animation-play-state: paused; }
.assistant[data-state="idle"] { animation-play-state: running; }

@keyframes clawdTravel { 0%, 8% { left: var(--travel-start); } 43% { left: var(--travel-end); } 57% { left: var(--travel-end); } 92% { left: var(--travel-start); } 100% { left: var(--travel-start); } }
@keyframes clawdDirection {
  0%, 48.5% { transform: scaleX(1); }
  49% { transform: scaleX(1) translateX(1px) rotate(1deg); }
  49.8% { transform: scaleX(1) translateX(0); }
  50% { transform: scaleX(-1) translateX(0); }
  50.8% { transform: scaleX(-1) translateX(1px) rotate(1deg); }
  51.5%, 98.5% { transform: scaleX(-1); }
  99% { transform: scaleX(-1) translateX(1px) rotate(1deg); }
  99.8% { transform: scaleX(-1) translateX(0); }
  100% { transform: scaleX(1); }
}
@keyframes clawdIdle { 0%, 100% { translate: 0 0; } 50% { translate: 0 -1px; } }
@keyframes clawdIdleWalk { 0%, 100% { translate: 0 0; rotate: 0deg; } 25% { translate: 0 -1px; rotate: -.35deg; } 50% { translate: 0 -1px; rotate: 0deg; } 75% { translate: 0 -1px; rotate: .35deg; } }
@keyframes clawdIdleShadow { 0%, 100% { transform: scaleX(1); opacity: .14; } 25%, 75% { transform: scaleX(.96); opacity: .13; } 50% { transform: scaleX(.93); opacity: .12; } }
@keyframes clawdIdleArmLeft { 0%, 100% { transform: translateY(2px) rotate(12deg); } 25% { transform: translateY(1px) rotate(3deg); } 50% { transform: translateY(0) rotate(-10deg); } 75% { transform: translateY(1px) rotate(2deg); } }
@keyframes clawdIdleArmRight { 0%, 100% { transform: translateY(0) rotate(-12deg); } 25% { transform: translateY(1px) rotate(-2deg); } 50% { transform: translateY(2px) rotate(10deg); } 75% { transform: translateY(1px) rotate(-3deg); } }
@keyframes clawdTurnPause { 0%, 42.5%, 57.5%, 100% { transform: translateY(0) scaleY(1); } 45%, 55% { transform: translateY(1px) scaleY(.98); } 49%, 51% { transform: translateY(0) scaleY(1); } }
@keyframes clawdTurnLook { 0%, 42%, 58%, 100% { translate: 0 0; } 45%, 47% { translate: 2px 0; } 53%, 55% { translate: -2px 0; } }
@keyframes clawdStateEnter { 0% { translate: 0 2px; opacity: .96; } 50% { translate: 0 -2px; } 100% { translate: 0 0; opacity: 1; } }
@keyframes clawdPropIn { 0% { opacity: 0; transform: translateY(3px); } 100% { opacity: 1; transform: translateY(0); } }
@keyframes clawdWake { 0% { translate: 0 3px; } 50% { translate: 0 -1px; } 100% { translate: 0 0; } }
@keyframes clawdWaiting { 0%, 36%, 100% { translate: 0 0; } 56% { translate: 0 -1px; } 74% { translate: 0 0; } }
@keyframes clawdWaitingEyes { 0%, 28%, 100% { translate: -2px 0; } 46%, 72% { translate: 2px 0; } 84% { translate: 0 0; } }
@keyframes clawdWaitDot { 0%, 100% { opacity: .25; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }
@keyframes clawdShadow { 0%, 100% { transform: scaleX(1); opacity: .14; } 50% { transform: scaleX(.92); opacity: .11; } }
@keyframes clawdStaticShadow { 0%, 100% { transform: scaleX(1); opacity: .13; } 50% { transform: scaleX(.98); opacity: .12; } }
@keyframes clawdLook { 0%, 22%, 100% { translate: 0 0; } 30%, 40% { translate: -2px 0; } 50%, 64% { translate: 2px 0; } 72%, 80% { translate: 0 1px; } }
@keyframes clawdScan { 0%, 100% { translate: -2px 0; } 50% { translate: 2px 0; } }
@keyframes clawdCodeLook { 0%, 20%, 100% { translate: 0 2px; } 40%, 55% { translate: -1px 0; } 72%, 86% { translate: 1px 0; } }
@keyframes clawdReviewEyes { 0%, 18%, 100% { translate: 0 0; } 36%, 48% { translate: 0 2px; } 66%, 80% { translate: 1px 3px; } }
@keyframes clawdBlink { 0%, 45%, 49%, 100% { scale: 1 1; } 47% { scale: 1 .12; } }
@keyframes clawdCuriousPause { 0% { translate: 0 0; } 25% { translate: 0 -1px; } 50%, 78% { translate: 0 0; } 100% { translate: 0 0; } }
@keyframes clawdCuriousEyes { 0% { translate: 0 0; scale: 1 1; } 25%, 72% { translate: 0 -2px; scale: 1 1; } 78% { translate: 0 -2px; scale: 1 .15; } 88%, 100% { translate: 1px 0; scale: 1 1; } }
@keyframes clawdHappySettle { 0%, 38%, 100% { translate: 0 0; } 54% { translate: 0 -1px; } 68% { translate: 0 0; } }
@keyframes clawdIdleBlink { 0%, 42%, 46%, 50%, 54%, 100% { scale: 1 1; } 44%, 52% { scale: 1 .12; } }
@keyframes clawdAlertBlink { 0%, 76%, 82%, 100% { scale: 1 1; } 79% { scale: 1 .12; } }
@keyframes clawdAlertLook { 0%, 100% { translate: 0 0; } 25% { translate: -2px 0; } 50% { translate: 2px 0; } 75% { translate: 0 1px; } }
@keyframes clawdAttention { 0%, 100% { translate: 0 0; } 18% { translate: -2px 0; } 36% { translate: 2px 0; } 54% { translate: -2px -1px; } 72% { translate: 2px -1px; } }
@keyframes clawdWorking { 0%, 100% { translate: 0 0; } 50% { translate: 0 -2px; } }
@keyframes clawdValidate { 0%, 100% { translate: 0 0; } 50% { translate: 0 -2px; } }
@keyframes clawdThink { 0%, 100% { translate: 0 0; } 50% { translate: 0 -2px; } }
@keyframes clawdThinkLook { 0%, 100% { translate: 1px -1px; } 26% { translate: 3px -3px; } 58% { translate: -1px -2px; } 80% { translate: 1px 0; } }
@keyframes clawdThoughtFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
@keyframes clawdRead { 0%, 100% { translate: 0 0; } 50% { translate: 0 -1px; } }
@keyframes clawdPageTurn { 0%, 62%, 100% { transform: translateY(0); } 70% { transform: translateY(-1px) rotate(-1deg); } 78% { transform: translateY(-1px) rotate(1deg); } 86% { transform: translateY(0); } }
@keyframes clawdReadEyes { 0%, 100% { translate: -2px 2px; } 50% { translate: 2px 2px; } }
@keyframes clawdReview { 0%, 100% { translate: 0 0; } 50% { translate: 0 -2px; } }
@keyframes clawdClipboardPulse { 0%, 56%, 100% { transform: translate(0, 0); } 66% { transform: translate(0, -1px); } 76% { transform: translate(0, 0); } }
@keyframes clawdCursorBlink { 0%, 45% { opacity: 1; } 46%, 100% { opacity: 0; } }
@keyframes clawdCodeLines { 0%, 18%, 58%, 100% { width: 16px; } 28%, 44% { width: 11px; } 72% { width: 19px; } 84% { width: 14px; } }
@keyframes clawdLensSweep { 0%, 18% { left: -8px; } 52%, 66% { left: 8px; } 100% { left: -8px; } }
@keyframes clawdInspectHand { 0%, 20%, 100% { transform: translate(-4px, 7px) rotate(-68deg); } 46%, 64% { transform: translate(-5px, 6px) rotate(-72deg); } 80% { transform: translate(-4px, 7px) rotate(-66deg); } }
@keyframes clawdInspectGlass { 0%, 20%, 100% { transform: translate(-1px, -2px) rotate(-4deg); } 46%, 64% { transform: translate(0, -3px) rotate(2deg); } 80% { transform: translate(-1px, -2px) rotate(-2deg); } }
@keyframes clawdPageCorner { 0%, 62%, 100% { transform: skewY(12deg) translateY(0); opacity: .45; } 72% { transform: skewY(18deg) translateY(-2px); opacity: .9; } 84% { transform: skewY(12deg) translateY(0); opacity: .55; } }
@keyframes clawdCheckPulse { 0%, 56%, 100% { transform: scale(1); } 66% { transform: scale(1.10); } 76% { transform: scale(1); } }
@keyframes clawdBlockedWobble { 0%, 62%, 100% { transform: rotate(0deg); } 70% { transform: rotate(-5deg); } 78% { transform: rotate(5deg); } 86% { transform: rotate(-3deg); } 94% { transform: rotate(0deg); } }
@keyframes clawdAttentionWave { 0%, 56%, 100% { transform: translate(1px, -4px) rotate(-56deg); } 64% { transform: translate(2px, -6px) rotate(-72deg); } 72% { transform: translate(1px, -4px) rotate(-50deg); } 80% { transform: translate(2px, -6px) rotate(-70deg); } 88% { transform: translate(1px, -4px) rotate(-56deg); } }
@keyframes clawdWakeToWalk { 0% { translate: 0 3px; } 35% { translate: 0 0; } 70% { translate: 0 -1px; } 100% { translate: 0 0; } }
@keyframes clawdLaptopIn { 0% { opacity: 0; transform: translate(0, 5px) scale(.96); } 100% { opacity: 1; transform: translate(0, 1px) scale(1); } }
@keyframes clawdGlassLift { 0% { opacity: 0; transform: translate(-2px, 4px) rotate(6deg); } 100% { opacity: 1; transform: translate(-1px, -2px) rotate(-4deg); } }
@keyframes clawdClipboardIn { 0% { opacity: 0; transform: translate(-2px, 4px) rotate(-4deg); } 100% { opacity: 1; transform: translate(0, 0) rotate(0deg); } }
@keyframes clawdSuccessEntry { 0% { translate: 0 0; } 22% { translate: 0 1px; } 55% { translate: 0 -8px; } 100% { translate: 0 0; } }
@keyframes clawdAttentionEntry { 0% { transform: translate(0, 0) rotate(-20deg); } 100% { transform: translate(1px, -4px) rotate(-56deg); } }
@keyframes clawdBlocked { 0%, 74%, 100% { translate: 0 0; } 78% { translate: -2px 0; } 84% { translate: 2px 0; } 90% { translate: -1px 0; } }
@keyframes clawdSleep { 0%, 100% { translate: 0 0; } 50% { translate: 0 2px; } }
@keyframes clawdSuccess { 0%, 100% { translate: 0 0; } 45%, 55% { translate: 0 -9px; } }
@keyframes clawdIdleLegA { 0%, 100% { transform: translateY(0) rotate(4deg); } 25% { transform: translateY(-1px) rotate(1deg); } 50% { transform: translateY(-3px) rotate(-4deg); } 75% { transform: translateY(-1px) rotate(0deg); } }
@keyframes clawdIdleLegB { 0%, 100% { transform: translateY(-3px) rotate(-4deg); } 25% { transform: translateY(-1px) rotate(0deg); } 50% { transform: translateY(0) rotate(4deg); } 75% { transform: translateY(-1px) rotate(-1deg); } }
@keyframes clawdTypeLeft { 0%, 100% { transform: translate(15px, 10px) rotate(70deg); } 50% { transform: translate(17px, 12px) rotate(80deg); } }
@keyframes clawdTypeRight { 0%, 100% { transform: translate(-15px, 10px) rotate(-70deg); } 50% { transform: translate(-17px, 12px) rotate(-80deg); } }
@keyframes clawdConfetti { 0% { translate: 0 7px; opacity: 0; } 35%, 70% { opacity: 1; } 100% { translate: 0 -11px; opacity: 0; } }
@keyframes clawdZ { 0% { transform: translateY(4px); opacity: 0; } 25%, 70% { opacity: 1; } 100% { transform: translateY(-6px); opacity: 0; } }

.clawd-root.reduce-motion .assistant.clawd-assistant,
.clawd-root.reduce-motion .clawd-stage,
.clawd-root.reduce-motion .clawd-shadow,
.clawd-root.reduce-motion .clawd-body,
.clawd-root.reduce-motion .clawd-eye,
.clawd-root.reduce-motion .clawd-arm,
.clawd-root.reduce-motion .clawd-leg,
.clawd-root.reduce-motion .clawd-particle,
.clawd-root.reduce-motion .clawd-z,
.clawd-root.reduce-motion .clawd-thought,
.clawd-root.reduce-motion .clawd-wait-dot { animation: none !important; }

@media (prefers-reduced-motion: reduce) {
  .assistant.clawd-assistant, .clawd-stage, .clawd-shadow, .clawd-body, .clawd-eye, .clawd-arm, .clawd-leg,
  .clawd-particle, .clawd-z, .clawd-thought, .clawd-wait-dot { animation: none !important; }
}

@media (max-width: 760px) {
  .assistant.clawd-assistant { --travel-start: 16px; --travel-end: calc(100% - 168px); }
}
`;
