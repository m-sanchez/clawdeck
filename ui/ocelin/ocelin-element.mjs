import { ClawdAssistant } from "../clawd/clawd-element.mjs";
import { applyOcelotArtwork, OCELOT_PALETTE } from "./ocelot-art.mjs";

export class OcelinAssistant extends ClawdAssistant {
  connectedCallback() {
    if (!this._ocelin) {
      this._ocelin = true;
      this.dataset.variant = "ocelot";
      this.style.setProperty("--brand", OCELOT_PALETTE.coat);
      this.style.setProperty("--brand-dark", OCELOT_PALETTE.spot);
      this.style.setProperty("--face", OCELOT_PALETTE.eye);
      const body = this.shadowRoot.querySelector(".clawd-body");
      for (const className of ["ocelin-ear left", "ocelin-ear right", "ocelin-tail"]) {
        const part = document.createElement("span"); part.className = className; body.append(part);
      }
      const style = document.createElement("style");
      style.textContent = `.ocelin-ear,.ocelin-tail{position:absolute;pointer-events:none}.ocelin-ear{z-index:1;transform-origin:center bottom}.ocelin-tail{z-index:0}.ocelin-ear.right{scale:-1 1}:host([compact]) .assistant-dock{display:none}:host([compact]) .clawd-shadow{visibility:var(--ocelin-compact-shadow,visible)}:host([compact]) .assistant.clawd-assistant{--travel-start:-22px;--travel-end:-22px;left:-22px;bottom:var(--ocelin-compact-bottom,-26px);transform:scale(var(--ocelin-compact-scale,.75));transform-origin:50% 100%}:host([compact]) .clawd-root{overflow:visible}`;
      this.shadowRoot.append(style);
      applyOcelotArtwork(this);
    }
    super.connectedCallback();
  }
}
if (!customElements.get("ocelin-assistant")) customElements.define("ocelin-assistant", OcelinAssistant);
