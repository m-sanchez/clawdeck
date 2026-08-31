# Working on Clawdeck

A local operator dashboard for Claude Code: a zero-dependency Node server
(`server/`) plus a browser-native ESM UI (`ui/`). Lifecycle and validation
scripts live in `scripts/`, the installable hook pipeline in `hooks/`, unit
tests in `tests/`, typed contracts in `contracts/`, and the canonical Clawd
reference in `reference/`. See `README.md` to use it and `ARCHITECTURE.md` for
the design.

Constraints to keep:

- **Zero runtime dependencies.** The server and UI use only Node and browser
  built-ins. Third-party assets are served through the strict `/vendor` allowlist,
  never a bare import.
- **Loopback only.** Bind `127.0.0.1` and reject unexpected `Host` headers. Every
  mutating action is individually allowlisted with validated parameters; there is no
  arbitrary shell or filesystem endpoint. Secrets stay server-side and write-only.
- **Install root ≠ observed checkout.** Clawdeck runs from its own repository
  against any target project (`--checkout` / `PANEL_CHECKOUT_ROOT`). Never
  hardcode paths that assume the panel lives inside the observed repo, and
  degrade gracefully when target-side tooling is absent.
- **Windows:** any timer or child process that shells git must pass
  `windowsHide: true`.

Validate before claiming done: `node scripts/self-test.mjs` and `node --test tests/`.
Use explicit binary paths, not `npx`.

Treat `reference/clawd-playground-v16.html` as the canonical Clawd reference;
preserve its silhouette, state vocabulary, motion, overlap protections, and
reduced-motion behaviour.
