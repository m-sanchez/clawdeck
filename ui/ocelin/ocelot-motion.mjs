const standingStates = ["thinking", "reading", "working", "validating", "reviewing", "attention", "success"];
const standing = `.assistant:is(${standingStates.map((state) => `[data-state='${state}']`).join(", ")})`;
const s = ":host([data-variant='ocelot'])";
const enteringProps = Object.entries({ sleeping: "sleep", thinking: "thought", reading: "book", working: "laptop", validating: "glass", reviewing: "clipboard", waiting: "wait-dots", blocked: "blocked-sign" })
  .map(([state, prop]) => `${s} .assistant.state-enter[data-state='${state}'] .clawd-${prop}`).join(",\n");
const svg = (width, height, content) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${content}</svg>`;

export function applyOcelotMotion(mascot, p) {
  const root = mascot.shadowRoot;
  const paper = "#f4e6c8";
  root.querySelectorAll(".leg-2, .leg-3").forEach((leg) => leg.remove());
  root.querySelectorAll(".clawd-arm").forEach((paw) => { paw.dataset.limb = "front"; });
  root.querySelectorAll(".clawd-leg").forEach((paw) => { paw.dataset.limb = "hind"; });

  const props = {
    ".clawd-laptop": svg(24, 15, `
      <path fill="${p.eye}" d="M3 0h18v10h3v4H0v-4h3z"/>
      <path fill="${paper}" d="M4 1h16v9H4z"/>
      <path fill="${p.light}" d="M1 11h22v2H1z"/>
      <path fill="${p.shade}" d="M6 3h5v1H6zM6 5h8v1H6zM4 12h4v1H4zM10 12h4v1h-4zM16 12h4v1h-4z"/>
      <path class="ocelin-cursor" fill="${p.eye}" d="M16 3h1v3h-1z"/>
    `),
    ".clawd-book": svg(26, 14, `
      <path fill="${p.eye}" d="M0 1h9v1h3v1h2V2h3V1h9v12h-9v-1h-3v1h-2v-1H9v1H0z"/>
      <path fill="${paper}" d="M1 2h8v1h3v8H9v1H1zM17 2h8v10h-8v-1h-3V3h3z"/>
      <path fill="${p.shade}" d="M12 3h2v10h-2zM3 5h5v1H3zM3 8h6v1H3zM17 5h5v1h-5z"/>
      <path class="ocelin-page-mark" fill="${p.shade}" d="M17 8h6v1h-6z"/>
    `),
    ".clawd-clipboard": svg(15, 16, `
      <path fill="${p.eye}" d="M1 2h13v14H1zM4 0h7v4H4z"/>
      <path fill="${paper}" d="M2 3h11v12H2z"/>
      <path fill="${p.light}" d="M5 1h5v2H5z"/>
      <path fill="${p.shade}" d="M4 11h7v1H4zM4 13h5v1H4z"/>
      <path class="ocelin-check" fill="#587652" d="M4 7h2v2H4zM6 8h1v2H6zM7 6h1v3H7zM8 5h2v2H8z"/>
    `),
    ".clawd-glass": svg(12, 16, `
      <path fill="${p.eye}" d="M3 0h6v1h2v2h1v6h-1v2H9v1H3v-1H1V9H0V3h1V1h2zM5 11h3v5H5z"/>
      <path fill="${paper}" d="M3 2h6v1h1v6H9v1H3V9H2V3h1z"/>
      <path fill="${p.light}" d="M3 7h1v2H3zM4 8h4v1H4z"/>
    `),
    ".clawd-wait-dots": svg(24, 12, `
      <path fill="${p.eye}" d="M2 0h20v1h2v8h-2v1H6v2H4v-2H2V9H0V1h2z"/>
      <path fill="${paper}" d="M2 1h20v1h1v6h-1v1H2V8H1V2h1z"/>
      <path class="ocelin-dot dot-1" fill="${p.shade}" d="M5 4h2v2H5z"/>
      <path class="ocelin-dot dot-2" fill="${p.shade}" d="M11 4h2v2h-2z"/>
      <path class="ocelin-dot dot-3" fill="${p.shade}" d="M17 4h2v2h-2z"/>
    `),
    ".clawd-blocked-sign": svg(14, 14, `
      <path fill="#a3513e" d="M3 0h8v1h2v2h1v8h-1v2h-2v1H3v-1H1v-2H0V3h1V1h2z"/>
      <path fill="${paper}" d="M6 3h2v5H6zM6 10h2v2H6z"/>
    `),
  };
  for (const [selector, art] of Object.entries(props)) root.querySelector(selector).innerHTML = art;

  const style = document.createElement("style");
  style.textContent = `
${s} .clawd-body { transition: translate .24s steps(3, end); }
${s} .assistant .clawd-arm:is(.left, .right) { top: 40px; width: 8px; height: 18px; transform: none; animation: none; box-shadow: inset 0 -2px ${p.shade}; transition: top .24s steps(5, end), left .24s steps(7, end), right .24s steps(7, end), width .24s steps(2, end), height .24s steps(5, end); }
${s} .assistant .clawd-arm.left { left: 20px; }
${s} .assistant .clawd-arm.right { right: 20px; }
${s} .assistant .clawd-leg { top: 40px; height: 18px; transform: none; animation: none; box-shadow: inset 0 -2px ${p.shade}; transition: height .24s steps(3, end), left .24s steps(3, end), right .24s steps(3, end); }
${s} ${standing} .clawd-body { translate: 0 -6px; }
${s} ${standing} .clawd-leg { height: 24px; }
${s} ${standing} .leg-1 { left: 16px; }
${s} ${standing} .leg-4 { right: 16px; }
${s} ${standing} .clawd-arm:is(.left, .right) { top: 30px; z-index: 3; }
${s} ${standing} .clawd-arm.left { left: 6px; }
${s} ${standing} .clawd-arm.right { right: 6px; }
${s} .assistant[data-state='sleeping'] :is(.clawd-arm, .clawd-leg) { height: 14px; }
${s} .assistant[data-state='blocked'] :is(.clawd-arm, .clawd-leg) { height: 16px; }
${s} .assistant[data-state='thinking'] .clawd-arm.right { top: 30px; right: 18px; width: 16px; height: 8px; }
${s} .assistant[data-state='working'] .clawd-arm:is(.left, .right) { top: 38px; width: 12px; height: 10px; z-index: 5; animation: ocelinType 1.2s steps(1, end) infinite; }
${s} .assistant[data-state='working'] .clawd-arm.left { left: 8px; }
${s} .assistant[data-state='working'] .clawd-arm.right { right: 8px; animation-delay: -.6s; }
${s} .assistant[data-state='reviewing'] .clawd-arm.left { left: 8px; }
${s} .assistant[data-state='reviewing'] .clawd-arm.right { top: 36px; right: 14px; width: 20px; height: 8px; z-index: 5; }
${s} .assistant[data-state='validating'] .clawd-arm.right { top: 34px; right: -12px; width: 18px; height: 8px; z-index: 5; animation: ocelinInspect 2.8s steps(1, end) infinite; }
${s} .assistant[data-state='attention'] .clawd-arm.right { top: 8px; right: -4px; height: 20px; animation: ocelinWave 2.6s steps(1, end) infinite; }
${s} .assistant[data-state='success'] .clawd-arm:is(.left, .right) { top: 8px; height: 20px; }
${s} .assistant[data-state='success'] .clawd-arm.left { left: -4px; }
${s} .assistant[data-state='success'] .clawd-arm.right { right: -4px; }
${s} .assistant[data-state='success'].success-settled .clawd-arm:is(.left, .right) { top: 30px; height: 18px; transform: none; }
${s} .assistant[data-state='success'].success-settled .clawd-arm.left { left: 6px; }
${s} .assistant[data-state='success'].success-settled .clawd-arm.right { right: 6px; }
${s} .assistant[data-state] .clawd-prop { transform: none; animation: none; transition: opacity .12s steps(2, end); }
${s} .clawd-laptop { left: 10px; top: 24px; width: 48px; height: 30px; }
${s} .clawd-book { left: 8px; top: 30px; width: 52px; height: 28px; background: none; clip-path: none; filter: none; }
${s} .clawd-clipboard { left: 14px; top: 28px; width: 30px; height: 32px; }
${s} .clawd-glass { left: 64px; right: auto; top: 8px; width: 24px; height: 32px; }
${s} .clawd-wait-dots { right: -44px; top: 8px; width: 48px; height: 24px; padding: 0; border: 0; background: none; box-shadow: none; display: block; }
${s} .clawd-blocked-sign { right: -24px; top: 8px; width: 28px; height: 28px; border: 0; background: none; box-shadow: none; }
${s} .assistant[data-state='working'] .ocelin-cursor { animation: ocelinBlink 1.2s steps(1, end) infinite; }
${s} .assistant[data-state='reading'] .ocelin-page-mark { animation: ocelinRead 4.8s steps(1, end) infinite; }
${s} .assistant[data-state='reviewing'] .ocelin-check { animation: ocelinRead 3.6s steps(1, end) infinite; }
${s} .assistant[data-state='validating'] .clawd-glass { animation: ocelinInspect 2.8s steps(1, end) infinite; }
${s} .assistant[data-state='waiting'] .ocelin-dot { animation: ocelinRead 1.8s steps(1, end) infinite; }
${s} .assistant[data-state='waiting'] .dot-2 { animation-delay: -.6s; }
${s} .assistant[data-state='waiting'] .dot-3 { animation-delay: -1.2s; }
${enteringProps} { animation: ocelinPropArrive .3s steps(3, end) both; }
@keyframes ocelinType { 0%, 35%, 100% { translate: 0 0; } 45%, 70% { translate: 0 -2px; } }
@keyframes ocelinInspect { 0%, 30%, 100% { translate: 0 0; } 45%, 70% { translate: 0 -2px; } }
@keyframes ocelinWave { 0%, 45%, 100% { translate: 0 0; } 55%, 75% { translate: 2px -2px; } 65%, 85% { translate: 0 -2px; } }
@keyframes ocelinBlink { 0%, 60%, 100% { opacity: 1; } 65%, 95% { opacity: 0; } }
@keyframes ocelinRead { 0%, 100% { opacity: 1; } 65%, 80% { opacity: .35; } }
@keyframes ocelinPropArrive { 0%, 35% { opacity: 0; } 70%, 100% { opacity: 1; } }
`;
  root.append(style);
}
