const paths = {
  codex: '<path d="m5 7 5 5-5 5m8 0h6"/>',
  claude:
    '<path d="M12 2v20M2 12h20M5 5l14 14M5 19 19 5M8 3l8 18M3 8l18 8M3 16l18-8M8 21 8-18"/>',
  folder: '<path d="M3 7V5h6l2 2h10v12H3Z"/>',
  open: '<path d="M14 3h7v7m0-7L10 14M10 5H4v15h15v-6"/>',
  settings:
    '<path d="m9 3-1 3-3 1-2 3 2 2v4l3 1 1 4h6l1-4 3-1v-4l2-2-2-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 7V3l-3 2a8 8 0 1 0 3 10M20 7h-5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  memory:
    '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h2v4H7Zm8 0h2v4h-2ZM6 18v3m4-3v3m4-3v3m4-3v3"/>',
  hide: '<path d="M5 12h14"/>',
  seen: '<path d="m5 12 4 4L19 6"/>',
};
export function icon(name) {
  const span = document.createElement("span");
  span.className = `icon icon-${name}`;
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.codex}</svg>`;
  return span;
}
export function providerIcon(provider) {
  const span = icon(provider);
  span.classList.add("provider-icon");
  span.title =
    provider === "claude"
      ? "Claude"
      : provider === "codex"
        ? "Codex"
        : "Ocelin";
  if (provider === "ocelin")
    span.innerHTML = '<img src="/ui/ocelin/icon.svg" alt=""/>';
  return span;
}
