# Architecture

## Optional Windows companion

Ocelin's optional `desktop/` Electron package owns the tray, floating bar, windows and notifications. One `server/monitor/worker.mjs` utility process discovers local Codex and Claude sessions, reduces lifecycle evidence and persists metadata checkpoints. Renderer IPC exposes named actions for known sessions. The existing loopback project backend starts only when a project is opened; `server/monitor/shared.mjs` supplies its session rows from the shared collector. The browser-only launcher remains independent. See [Windows desktop](docs/WINDOWS-DESKTOP.md) for the compatibility and trust boundaries.

## Boundary

```text
Browser dashboard (ui/ - browser-native ESM, no build step)
    │
    │ HTTP + SSE on 127.0.0.1
    ▼
server/ (Node stdlib only)
    │
    ├── adapters/   raw facts: sessions, worktrees, checkout, reviews,
    │               validation, runs, logs, telemetry, diff, instruction budget
    ├── core/       event store + projection, findings, telemetry rollups,
    │               delivery lifecycle, OTEL receiver
    ├── forge/      provider-detected GitHub / GitLab read-only connectors
    ├── jobs/       allowlisted long-running child processes
    └── lib/        http, snapshot, actions (allowlisted), command registry,
                    secret scan, policy seam
          │
          ▼
The observed checkout's own scripts and git state, plus Claude Code's
harness-level files (~/.claude/projects, ~/.claude/tasks), plus Codex
rollouts ($CODEX_HOME/sessions, default ~/.codex/sessions)
```

The browser is never a privileged filesystem or shell client.

Codex discovery reads bounded rollout headers to match session working directories
to observed worktrees. Metadata and bounded tail summaries are cached; completion
markers override recent file activity. Codex messages and calls normalize into the
existing feed and trace contracts, behind the same token and worktree validation.
Dollar costs remain unknown when the transcript does not report them.

## Install root vs observed checkout

Clawdeck runs **from its own repository** against **any target project**:

- `panelRoot` - where Clawdeck is installed. Derived from `import.meta.url`,
  never from the target.
- `checkoutRoot` - the observed project. `--checkout <dir>` >
  `PANEL_CHECKOUT_ROOT` > cwd. A non-git directory degrades with a warning.

All runtime state lives on the target side under
`.claude/.runtime/{panel,events,telemetry}/`, so observing a project leaves
Clawdeck's own tree untouched.

## Event spine

```text
Claude Code lifecycle hooks
    └─ hooks/emit-event.cjs (installed into the target's .claude/hooks/)
         ├─ appends a redacted envelope to the durable spool (at-least-once)
         └─ best-effort POST to the running panel (per-launch ingest token)
              └─ single-writer event store → projection → SSE → UI
```

The spool guarantees nothing is lost while the panel is down; the panel
promotes it on start. A writer lock keeps the canonical store single-writer;
a second panel degrades to a local store instead of corrupting it.

## Optional integration seams

- **Statusline bridge** (`hooks/statusline-bridge.cjs`) - Claude Code invokes
  it per assistant message; it writes per-session cost/context telemetry the
  Cost view reads. Optional.
- **OTEL** - an OTLP-JSON receiver accepts Claude Code's metrics exporter.
  Optional.
- **Policy** - a generic seam: if the target ships its own
  `.claude/hooks/lib/policy-state.cjs`, per-session policy state is surfaced;
  Clawdeck ships no policy implementation.
- **Checkout tooling** - command-registry entries that run target scripts
  (verify, lint, worktree lifecycle) appear only when the target provides
  them; git commands always work.

## Process model

Each observed checkout has a deterministic identity and separate runtime dir:

```text
<target>/.claude/.runtime/panel/<checkout-id>/
├── registry.json
├── panel.token       (0600; the browser gets it only via URL fragment)
└── *.log
```

Only PIDs recorded in that registry - and proving ownership via a per-launch
nonce on `/health` - may be stopped by the lifecycle scripts.

## Real-time model

Request/response for snapshots and actions; SSE for the one-way stream of
events and periodic snapshots. The server never watches the filesystem - it
polls adapters per request and on a bounded SSE interval.

## Clawd rendering

The mascot's canonical reference is `reference/clawd-playground-v16.html`; a
pure function derives `ClawdState` from workflow facts, and the component only
renders its typed inputs. The reference remains authoritative if any
extraction changes its appearance.
