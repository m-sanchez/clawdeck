import { applyOcelotMotion } from "./ocelot-motion.mjs";

export const OCELOT_PALETTE = {
  coat: "#d9a252",
  light: "#edbd77",
  shade: "#bd853f",
  spot: "#885e36",
  eye: "#493527",
};

const p = OCELOT_PALETTE;
const svg = (width, height, content) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${content}</svg>`;

const coat = svg(34, 22, `
  <path fill="${p.coat}" d="M4 0h26v2h2v2h2v14h-2v2h-2v2H4v-2H2v-2H0V4h2V2h2z"/>
  <path fill="${p.light}" d="M4 0h26v1H4z"/>
  <path fill="${p.shade}" d="M2 18h2v2h26v-2h2v2h-2v2H4v-2H2z"/>
  <path fill="${p.spot}" d="M5 3h2v2H5zM12 2h2v1h-2zM21 3h2v2h-2zM28 4h2v2h-2z"/>
`);

const ear = svg(6, 7, `
  <path fill="${p.coat}" d="M1 0h4v1h1v6H0V1h1z"/>
  <path fill="${p.spot}" d="M1 1h2v2H1z"/>
`);

const tail = svg(16, 16, `
  <path fill="${p.coat}" d="M0 4h4v9H0z"/>
  <g class="ocelin-tail-tip">
    <path fill="${p.coat}" d="M11 1h3v9h-1v2h-2v2H2v-3h8V9h1z"/>
    <path fill="${p.spot}" d="M11 1h3v3h-3zM11 7h3v2h-3zM7 11h2v3H7z"/>
  </g>
`);

const artworkStyle = `
:host([data-variant='ocelot']) .clawd-shell { background: none; clip-path: none; box-shadow: none; }
:host([data-variant='ocelot']) svg { display: block; overflow: visible; }
:host([data-variant='ocelot']) .ocelin-ear { top: -8px; width: 12px; height: 14px; background: none; clip-path: none; border: 0; }
:host([data-variant='ocelot']) .ocelin-ear.left { left: 6px; }
:host([data-variant='ocelot']) .ocelin-ear.right { right: 6px; }
:host([data-variant='ocelot']) .ocelin-ear::after,
:host([data-variant='ocelot']) .ocelin-tail::after,
:host([data-variant='ocelot']) .ocelin-mark { display: none; }
:host([data-variant='ocelot']) .ocelin-tail { left: 56px; top: 22px; width: 32px; height: 32px; border: 0; border-radius: 0; rotate: none; animation: none; }
:host([data-variant='ocelot']) .ocelin-tail-tip { animation: ocelinPixelTail 4.8s steps(1, end) infinite; }
:host([data-variant='ocelot']) .clawd-eye { border-radius: 0; }
:host([data-variant='ocelot']) .assistant[data-state='idle'] .clawd-eye { height: 10px; }
:host([data-variant='ocelot']) .assistant[data-state='working'] .clawd-eye { top: 12px; height: 8px; }
:host([data-variant='ocelot']) .assistant[data-state='reading'] .clawd-eye { top: 14px; height: 10px; }
:host([data-variant='ocelot']) .assistant[data-state='reviewing'] .clawd-eye { top: 12px; height: 10px; }
:host([data-variant='ocelot']) .clawd-arm,
:host([data-variant='ocelot']) .clawd-leg { border: 0; background: ${p.coat}; box-shadow: none; }
:host([data-variant='ocelot']) .assistant[data-state='thinking'] .clawd-shell { transform: translateY(0); }
:host([data-variant='ocelot']) .assistant[data-state='thinking'] .ocelin-ear.left { rotate: 0deg; translate: 0 -2px; }
:host([data-variant='ocelot']) .assistant[data-state='sleeping'] .ocelin-ear { rotate: 0deg; translate: 0 4px; }
:host([data-variant='ocelot']) .assistant:is([data-state='sleeping'], [data-state='blocked']) .ocelin-tail { rotate: 0deg; }
:host([data-variant='ocelot']) .assistant:is([data-state='sleeping'], [data-state='blocked']) .ocelin-tail-tip { animation: none; }
:host([data-variant='ocelot']) .clawd-root.reduce-motion *,
:host([data-variant='ocelot'][data-paused]) * { animation: none !important; transition: none !important; }
@media (prefers-reduced-motion: reduce) { :host([data-variant='ocelot']) * { animation: none !important; transition: none !important; } }
@keyframes ocelinPixelTail { 0%, 100% { translate: 0 0; } 35% { translate: 0 -1px; } 65% { translate: 1px 0; } }
`;

export function applyOcelotArtwork(mascot) {
  const root = mascot.shadowRoot;
  root.querySelector(".clawd-shell").innerHTML = coat;
  root.querySelectorAll(".ocelin-ear").forEach((part) => { part.innerHTML = ear; });
  root.querySelector(".ocelin-tail").innerHTML = tail;
  const style = document.createElement("style");
  style.textContent = artworkStyle;
  root.append(style);
  applyOcelotMotion(mascot, p);
}

export function ocelotIcon(size) {
  const detailed = size === 24;
  const content = detailed ? `
    <path fill="${p.coat}" d="M3 2h4v1h1v4h8V3h1V2h4v1h1v6h1v10h-2v2H3v-2H1V9h1V3h1z"/>
    <path fill="${p.light}" d="M8 7h8v1H8z"/>
    <path fill="${p.shade}" d="M3 20h18v1H3z"/>
    <path fill="${p.spot}" d="M4 3h2v3H4zM18 3h2v3h-2zM5 8h2v1H5zM11 8h1v1h-1zM17 8h2v1h-2z"/>
    <path fill="${p.eye}" d="M6 11h3v4H6zM15 11h3v4h-3z"/>
  ` : `
    <path fill="${p.coat}" d="M2 1h3v3h6V1h3v1h1v4h1v7h-2v1H2v-1H0V6h1V2h1z"/>
    <path fill="${p.light}" d="M5 4h6v1H5z"/>
    <path fill="${p.shade}" d="M2 13h12v1H2z"/>
    <path fill="${p.spot}" d="M2 2h1v2H2zM12 2h1v2h-1zM4 5h1v1H4zM10 5h1v1h-1z"/>
    <path fill="${p.eye}" d="M4 7h2v3H4zM10 7h2v3h-2z"/>
  `;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${detailed ? 24 : 16} ${detailed ? 24 : 16}" shape-rendering="crispEdges" role="img" aria-label="Ocelot icon at ${size} pixels">${content}</svg>`;
}
