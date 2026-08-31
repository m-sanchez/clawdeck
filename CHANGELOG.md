# Changelog

## 0.3.0

Security and test-coverage hardening. Several boundaries the README named
were previously unproven or inconsistent; this release closes them and
pins each with a test against the real server.

### Security

- **Uniform read-auth.** Every `/api/*` route now requires the panel
  bearer, closing a gap where source-serving reads (`/api/diff`,
  `/api/working-tree`, `/api/reviews`, `/api/review-pack/preview`,
  `/api/logs`, `/api/snapshot`) were ungated while other reads were
  locked. Liveness (`/health`, `/api/version`) and ingest (its own token)
  are the documented exceptions.
- **Constant-time token comparison.** Bearer checks compare fixed-length
  SHA-256 digests through `timingSafeEqual`, not raw strings.
- **No shell in `editor.open`.** The editor launches through a fixed argv
  with no shell, replacing a `shell: true` spawn guarded by a character
  blocklist. On Windows it routes through `cmd /d /s /c` with a discrete
  argv and a two-character expansion guard.
- **Secrets at rest.** Writing a forge PAT now refuses outright if
  `settings.local.json` is tracked by git, adds the exclusion to
  `.git/info/exclude` (never the project's committed `.gitignore`), and no
  longer writes a `.bak` copy of the secret.
- **Snapshot isolation.** Each snapshot adapter is isolated, so one that
  throws degrades its own section instead of failing the whole snapshot
  and every SSE tick.

### Tests

- New live-server invariant tests: foreign `Host` → 421, path-traversal →
  403/404, cross-origin mutation → 403, source-reads require the token.
- New unit tests: PID/nonce service ownership, forge connector degradation
  (401 / 500 / timeout / malformed JSON never throw), store-level
  projection idempotency, editor argv launch and worktree containment.

### Docs

- `docs/DECISIONS.md` rewritten as a public architecture-decision log.
- `docs/SECURITY.md` corrected on what `/events` actually carries.
- README: OTEL exporter recipe, accurate test count, `npx`-vs-clone note
  for `init`.
- Removed extraction-residue tooling (`scripts/inspect-repo.mjs`, the
  repo-assessment schema, stale `.gitignore` entries).

## 0.2.0

Initial public release.
