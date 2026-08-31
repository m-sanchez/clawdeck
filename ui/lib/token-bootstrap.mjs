// @ts-check
/**
 * Panel bearer-token bootstrap.
 *
 * The launcher hands the secret over in the URL fragment. A fragment is never
 * sent to the server and never appears in a Referer header, so the token stays
 * out of request logs and out of the served HTML. First paint moves it into
 * sessionStorage and rewrites the address bar, so a copied URL carries no secret.
 *
 * Scope: this raises the bar for OTHER local users and for stray clients. A
 * process running as THIS user can read the token file and is out of scope.
 */

const KEY = "panel-token";
const TOKEN_RE = /(?:^#|[#&])token=([A-Za-z0-9._-]+)/;

/**
 * Consume `#token=…` if present, remember it, and strip it from the URL.
 * @returns {string|null} the token now in effect
 */
export function bootstrapToken(
  loc = globalThis.location,
  hist = globalThis.history,
  store = globalThis.sessionStorage,
) {
  try {
    const hash = String(loc?.hash || "");
    const match = TOKEN_RE.exec(hash);
    if (match) {
      store.setItem(KEY, match[1]);
      const rest = hash.replace(TOKEN_RE, "").replace(/^[#&]+/, "");
      hist.replaceState(
        null,
        "",
        `${loc.pathname}${loc.search}${rest ? `#${rest}` : ""}`,
      );
    }
    return store.getItem(KEY);
  } catch {
    return null; // storage disabled: the UI reports "token required"
  }
}

/** The token in effect, or null. */
export function panelToken(store = globalThis.sessionStorage) {
  try {
    return store.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * Merge the bearer header into a fetch init, leaving it untouched when there is
 * no token (so the server's 401 is what tells the user, not a silent no-op).
 */
export function withToken(init = {}, store = globalThis.sessionStorage) {
  const token = panelToken(store);
  if (!token) return init;
  return {
    ...init,
    headers: { ...(init.headers || {}), "x-panel-token": token },
  };
}
