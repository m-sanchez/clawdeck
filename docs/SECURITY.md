# Security constraints

The panel is a privileged local developer tool. Treat the browser boundary as untrusted even though the service binds locally.

## Trust boundary (read this before changing an endpoint)

The panel hardens its **HTTP interface**. It is not a sandbox.

**Covered:** browser CSRF (Host allowlist, same-origin check, `form-action 'none'`, and a bearer token on every privileged route); other local *users*, who cannot read the token file under this profile; and stray local clients that do not know where the token lives.

**Not covered:** any process running as **this** user. It can read `panel.token`, and it can edit `.claude/.state/policy/*.json` directly without the panel at all. The token protects the HTTP surface, not the state on disk. Malware with the user's own permissions is explicitly out of scope.

### The token

- Generated per launch by the server, written to `<runtimeDir>/panel.token` with mode `0600`, and left to the profile's filesystem ACLs.
- Handed to the browser in the URL **fragment** (`http://127.0.0.1:<port>/#token=…`), which is never sent to the server and never appears in a `Referer`. `/panel` and `/panel-status` print that URL to the terminal and open it; the registry keeps the plain URL, and the log never sees the token.
- The UI consumes the fragment on first paint, keeps the value in `sessionStorage`, and rewrites the address bar with `history.replaceState`, so a copied URL carries no secret.
- Never embedded in the served HTML, an API response body, or a log line. A test pins all three.

### Routes that require it

**Every `/api/*` route** requires the panel bearer - one uniform read-auth policy applied in one place, covering mutations (`POST /api/actions/*`, `POST /api/jobs*`), sensitive reads (`/api/session-feed`, `/api/session-tasks`, `/api/trace`, `/api/diff`, snapshots), and everything else under `/api/`. The documented exceptions each carry a different trust story: `/api/version` is liveness metadata, and `POST /api/ingest/event` + `POST /v1/metrics` carry their own per-launch ingest token. Token comparisons are constant-time over fixed-length digests.

`/health` stays open: the lifecycle scripts poll it to prove ownership before stopping a pid. `/events` (SSE) stays open because `EventSource` cannot send headers; it carries the periodic snapshot (session state, counts, git and telemetry summaries, and worktree/commit paths) plus workflow event deltas - never prompt or command text. Treat everything on it as visible to anything that can reach the loopback port below the Host check.

## Binding

Bind to `127.0.0.1` by default. Do not expose the panel on all interfaces without explicit user configuration and a documented security review.

## Filesystem

- Serve only allowlisted files.
- Never expose the repository root as static content.
- Never serve `.env`, Git credentials, Claude settings, SSH material or token files.
- Canonicalise and validate every requested path.

## Commands

- Do not expose an arbitrary command endpoint.
- Define named, allowlisted operations.
- Validate arguments against typed schemas.
- Reuse existing safe lifecycle scripts when possible.
- Record process ownership before allowing stop/restart actions.

## Browser content

- Escape logs and repository strings before rendering.
- Avoid `innerHTML` for untrusted content.
- Apply a restrictive Content Security Policy where practical.
- Mutating endpoints need the bearer token **and** the same-origin check. The origin check alone lets any non-browser local client through, because a client that omits `Origin` is treated as same-origin.

## Network data

- Do not forward secrets to the browser.
- Return only the metadata needed for the UI.
- Keep SSE streams scoped and bounded.

## The Ask subprocess (`dash.ask`)

The one place the panel starts a Claude session of its own. Its boundary is structural, not advisory:

- The child is `claude -p` with a **fixed argv**: `--max-turns 1`, `--setting-sources ""` (no user or project instruction files), `--disallowedTools "*"` (no tools), `--strict-mcp-config` (no MCP servers). The question and the snapshot summary travel on **stdin only** - nothing user-controlled reaches the command line.
- Its working directory is a sterile per-call directory under the OS temp root - outside both the observed checkout and Clawdeck itself, so ancestor discovery finds nothing.
- Its environment is an **allowlist** (PATH, OS basics, the CLI's auth home); no `CLAUDE_*` or forge-token variables inherit.
- The full outbound payload is **secret-scanned fail-closed** first: a scan hit, or an unavailable scanner, refuses the call before any process is spawned; refusals report pattern names, never values.
- The prompt delimits the snapshot JSON as untrusted evidence and instructs the model to ignore directives inside it.

## Logs

- Redact known secret patterns where feasible.
- Store logs in `.claude/.runtime/panel/<checkout-id>/`.
- Avoid indefinitely growing log files.
