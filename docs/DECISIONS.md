# Architecture decisions

Why clawdeck is built the way it is. Each entry is a decision, the
reasoning behind it, and what it costs. These are the trade-offs a
reviewer would otherwise have to reverse-engineer from the code.

## Zero runtime dependencies

**Decision.** The whole tool — server, browser UI, CLI, hooks — runs on
system Node with no installed packages. HTML, CSS, and ES modules are
served directly; there is no bundler and no build step.

**Why.** clawdeck watches a developer's Claude Code sessions, so it has to
start instantly in any checkout, including a fresh worktree where nothing
has been installed yet. A dashboard that needs its own `npm install`
before it can render is a dashboard that is not there when you want it.
Zero dependencies also means the security surface is entirely in this
repository: there is no transitive tree to audit, and every guarantee the
README makes is carried by code you can read here.

**Cost.** No framework conveniences (no components, no reactive bindings,
no bundler tree-shaking). The UI is hand-written ES modules, and the code
pays for that in verbosity. For an operator console watched a few tabs at
a time, that is the right side of the trade.

## Polling, not filesystem watchers

**Decision.** The server derives its snapshot by polling git and reading
the event store on a timer, rather than subscribing to filesystem events.

**Why.** Watchers are per-platform, fire inconsistently across network and
virtualised filesystems, and coalesce or miss events under load — exactly
the conditions a busy checkout produces. A poll over a bounded set of
git commands and a capped event window is predictable, is trivially
degradable (a slow adapter degrades its own section, see below), and
cannot leak watcher handles. The snapshot is cheap enough that a short
interval keeps the UI live without a watcher's failure modes.

**Cost.** A small, bounded latency between an event landing and the UI
reflecting it, and steady low-cost git calls even when nothing changes.

## Single writer, leased

**Decision.** One process owns the canonical event store at a time, held by
a lease lock (O_EXCL create, heartbeat TTL, atomic steal-by-rename on
reclaim). A server that loses or never gets the lease degrades to a local
read-only store instead of writing.

**Why.** The event spool is multi-writer (hooks from many sessions append
to it), but the *projection* — the derived session state — must have one
owner, or two servers racing on the same store corrupt it. A lease is the
smallest mechanism that gives single-writer safety without a database or a
distributed lock service, and it fails safe: losing the lease demotes to
reads, it does not crash.

**Cost.** A second panel launched against the same checkout runs in a
degraded read-only mode rather than sharing write duty. That is the
correct outcome, but it is a surprise if you expected two live panels.

## The bearer token rides in the URL fragment

**Decision.** On launch the server writes a per-launch token to a
`0600` file and opens the browser at `…/#token=<token>`. The page reads the
fragment, stores the token, and strips it from the URL.

**Why.** The token has to reach the browser without ever being logged,
served in HTML, or sent to a server as a query parameter (query strings
land in access logs and `Referer` headers). A URL fragment is never sent
to any server and never appears in a `Referer`, so it is the one part of a
URL safe to carry a secret for the length of one hand-off. After the page
captures it, it lives only in that tab's session storage.

**Cost.** The token is single-use per launch and per browser session; open
the panel in another browser and you need the fresh link the CLI prints.
For a local, per-launch operator tool that is a feature, not a limit.

## Reads are gated; liveness and ingest are not

**Decision.** Every `/api/*` route requires the panel bearer, with two
deliberate exceptions: `/health` and `/api/version` (liveness, no data),
and `/api/ingest/event` (carries its own separate ingest token). The
`/events` SSE stream is the one tokenless data stream, because
`EventSource` cannot send headers.

**Why.** A single, uniform read-auth rule is easier to reason about than
per-route decisions, and it closed a real gap where some source-serving
reads were ungated while others were locked. The exceptions each have a
different trust story, stated in `docs/SECURITY.md`, rather than being
silent holes.

**Cost.** `/events` carries only what a tokenless stream may carry
(metadata deltas, documented in `SECURITY.md`); anything sensitive goes
through a gated JSON route instead.

## Named actions, never a command endpoint

**Decision.** The browser can trigger only a fixed allowlist of named
actions, each mapped to a specific script or state writer with validated,
typed parameters. There is no arbitrary-command route, and the one action
that launches an editor spawns a fixed binary with a discrete argv, never
a shell.

**Why.** A local web UI that can run shell commands is a local privilege
escalation waiting for a rebinding or cross-origin bug to reach it. An
allowlist means the worst a mis-scoped request can do is trigger a
known-safe operation, and a discrete argv means no parameter can break out
of a command line because there is no command line to break out of.

**Cost.** New capabilities require a new named action rather than a generic
"run this" escape hatch. That friction is the point.
