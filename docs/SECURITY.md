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

## The Git + Claude Workbench

The Workbench reads a forge and reasons about what it finds. Its boundary has
four parts, each pinned by a test:

**No forge mutation exists.** Review and CI access is GET-only over REST; the
single GraphQL POST carries a frozen read-only query document, and there is no
mutation document anywhere under `server/forge/`. No `reviewInbox.reply`,
`reviewInbox.resolve`, `forge.review.approve` or `forge.merge` action is
routable, so none can be called - by a person, by a page, or by a model. The
pre-existing `remote.deleteBranch` and `policy.approve` actions are outside this
boundary and unchanged.

**Tokens stay in `server/forge/*`.** A forge token never reaches the browser,
the SSE stream, a Claude prompt, a log line, or a stored review record. They are
read from the environment or the checkout's `settings.local.json`; for GitHub
only, and only when neither holds one, the already-authenticated `gh` CLI is
asked (cached, and skipped entirely with `CLAWDECK_NO_GH_CLI`). No process is
spawned when a token is configured. The
assist child's environment allowlist contains no `*_TOKEN` (the one credential
carve-out, `CLAUDE_CODE_OAUTH_TOKEN`, is documented under the Ask subprocess).

**Remote text is contained structurally, and treated as advisory.** Review
bodies and CI logs are sanitized (C0/C1 controls, bidi overrides and zero-width
marks stripped), capped, and placed inside a per-packet nonced block that the
text cannot close - near-miss sentinels are neutralized before assembly. This
prevents a comment from altering the packet's structure. It does not make the
text trustworthy: semantic injection remains possible, which is why model output
is advisory everywhere and can never move state, enter an authoritative
projection, or change readiness. Only a human action promotes advice.

**Payloads that grow are not in the snapshot.** `/events` is the one tokenless
stream, so review bodies, task briefs and CI job output never ride it. The
snapshot carries counts, identities and coverage; the material itself comes from
token-gated routes (`/api/review-inbox`, `/api/review-inbox/thread`, `/api/ci`,
`/api/ci/log`). The log route refuses any job id outside the CI read for the
current commit, so it is not a proxy to the provider's log storage, and the tail
it returns is secret-scanned fail-closed in both directions: a hit withholds the
text, and a scanner that cannot be loaded withholds it too.

**A task brief is a file, not a URL.** The `claude-cli://` deep link carries only
the task id, the brief's path, and a correlation marker. Review comments, diffs
and code context never enter a URL that browser and OS history retain. The brief
is secret-scanned before it is written, and a hit refuses the task.

## The Ask subprocess (`dash.ask`)

The one place the panel starts a Claude session of its own. Its boundary is structural, not advisory:

- The child is `claude -p` with a **fixed argv**: `--max-turns 1`, `--setting-sources ""` (no user or project instruction files), `--disallowedTools "*"` (no tools), `--strict-mcp-config` (no MCP servers). The question and the snapshot summary travel on **stdin only** - nothing user-controlled reaches the command line.
- Its working directory is a sterile per-call directory under the OS temp root - outside both the observed checkout and Clawdeck itself, so ancestor discovery finds nothing.
- Its environment is an **allowlist** (PATH, OS basics, the CLI's auth home). Forge tokens and API keys never inherit, and neither does any `CLAUDE_*` variable that steers behaviour. The single exception is `CLAUDE_CODE_OAUTH_TOKEN`: it is the child's own credential, installed by `claude setup-token`, and on a machine authenticated that way the CLI cannot start without it. The usual path is the credential file, reached through `HOME`/`USERPROFILE`, so this is a fallback rather than the norm.
- The full outbound payload is **secret-scanned fail-closed** first: a scan hit, or an unavailable scanner, refuses the call before any process is spawned; refusals report pattern names, never values.
- The prompt delimits the snapshot JSON as untrusted evidence and instructs the model to ignore directives inside it.

**Verified, not assumed** (Claude Code 2.1.252, 2026-09-01). The isolation was measured through the shipped invocation path, each probe planting a unique marker:

| Probe | Result |
| --- | --- |
| Child run inside a tree with `CLAUDE.md` at two ancestor levels plus `.claude/settings.json` | answered `NONE`; no marker returned |
| User-global `~/.claude/CLAUDE.md` planted (restored afterwards) | answered `NONE`; no marker returned |
| A file planted in the child's own working directory, asked for by name | the model emitted a read call, nothing executed it, the contents never came back |
| **Negative control**: same tree, same question, isolation arguments removed | the marker came back quoted verbatim |

The control is what makes the rest meaningful: without those arguments the instructions are plainly visible, so their absence with them is the arguments doing the work rather than there being nothing to find. Re-run the probes when the CLI's major version changes - this is a property of that binary, not a guarantee Clawdeck can enforce alone.

## Logs

- Redact known secret patterns where feasible.
- Store logs in `.claude/.runtime/panel/<checkout-id>/`.
- Avoid indefinitely growing log files.
