# Implementation decisions

Recorded after the Phase 0 repository assessment (`repo-assessment.json`,
`git worktree list`, direct reads of the worktree lifecycle scripts and the
review/hook libraries). Each decision cites the evidence that drove it.

## UI stack

**Decision:** Framework-independent, zero-build, browser-native ES modules
(HTML + CSS + `.js` modules served directly). No Angular, no bundler, no
runtime dependencies.

**Evidence:**

- `repo-assessment.json` reports `nodeModulesPresent: false` for every project
  (client, server, management-client, management-server). This is a fresh
  worktree; nothing can run until `/wt-setup` junctions `node_modules` from main.
  A panel that needs a junction merely to render its own dashboard is fragile.
- The client *does* have Angular + Angular CLI, but a standalone Angular app
  would (a) require the junction just to launch, (b) risk pulling the production
  application bootstrap/build graph into the panel, (c) need a Node wrapper to
  drive `ng` with a forwarded port. `ARCHITECTURE.md` only permits Angular "if it
  can remain isolated from the production application bootstrap"; the isolation
  cost here is high and the benefit for an operator console is low.
- No `vite` / `esbuild` / `webpack` is exposed as a direct dependency anywhere
  (Angular's internal esbuild is not a usable standalone binary), so the
  "framework-independent TS using an installed bundler" path has no bundler.
- Every existing `.claude/` tool is uniformly zero-dependency `.mjs`
  (`worktree-*.mjs`, `loop-state.mjs`, `mongo.mjs`, ...). Matching that
  convention keeps the panel consistent and lets it run on system Node alone
  (v22.13.0). The included starter already proves this path (`self-test` passes).

**Consequence:** The panel runs with **zero install**, in any checkout, before or
after `/wt-setup`. The repo's installed `tsc`/`eslint`/`prettier`/`jest` are used
only for the validation gates, never to run the panel.

## Local server stack

**Decision:** Evolve the included zero-dependency Node `http` server
(`server/`). HTTP request/response for snapshots and allowlisted actions;
**SSE** for live logs and workflow events. ESM `.mjs`. Real data comes from
typed adapters that import existing repo modules directly.

**Evidence / adapter sources (all dependency-free, already in the repo):**

| Adapter     | Source module (imported, not duplicated)                              |
| ----------- | -------------------------------------------------------------------- |
| checkout    | `git` via `execFile` (branch, commit, dirty, ahead/behind)          |
| worktrees   | `git worktree list --porcelain` + `.claude/scripts/worktree-registry.mjs` (`listEntries`, `detectMainRoot`, `isPidAlive`) + `worktree-ports.mjs` (`slotPorts`) |
| runs        | `.claude/scripts/loop-state.mjs` (`listRuns`, `readRun`, `finalReport`, `isStale`) - autoloop runs are the real run records |
| validation  | `.claude/scripts/worktree-verify.mjs --json` (allowlisted action; report cached under the runtime dir) |
| reviews     | `.claude/hooks/lib/review-run.js` (`runPrePush`) via `createRequire` (CJS) |
| logs        | tail of `.claude/.runtime/panel/<id>/*.log` + worktree run logs, streamed over SSE |

**No file watchers.** The server polls adapters per request and on an SSE
interval; it never recursively watches the tree. This satisfies the watch-safety
requirement (`.claude/worktrees/**`, `.claude/.runtime/**`, `.git/**`,
`**/node_modules/**`) by construction - there is nothing to exclude.

## Types

**Decision:** The `.ts` files in `contracts/` remain the authoritative contract.
Server and UI modules are plain `.mjs`/`.js` annotated with `// @ts-check` +
JSDoc `@typedef {import('...').X}` so they typecheck against the contracts using
the client's installed `typescript` when junctioned - but never need it to run.
The pure Clawd derivation is unit-tested with the built-in `node --test` runner
(zero dependency).

## Dependency links

**Decision:** The panel needs **no** dependency links to run. Links are created
only for the validation gates, using the provided `scripts/link-dependencies.mjs`
(directory junctions on Windows), pointing at the resolved main `node_modules`
via the existing `/wt-setup`. No `npx`, no global tools, no new packages.

## Worktree integration

**Decision:** Reuse, do not replace. Checkout identity, port allocation, process
ownership and runtime layout already come from `scripts/lib/context.mjs`,
`panel.config.json` and `panel-run.mjs` and are sound (deterministic
`checkoutId`, hashed port band, registry of owned PIDs, atomic writes). The
worktrees view *reads* the central `.claude/.wt-registry/` and `git worktree
list` so it reflects the same ports/slots the rest of the tooling reports. The
panel's own lifecycle (start/stop/status/full) is left intact.

## Clawd implementation

**Decision:** Extract a production Web Component `<clawd-assistant>` that
reproduces `reference/clawd-playground-v16.html` **verbatim** (same HTML shape
structure, same CSS shapes, same `@keyframes`, same state vocabulary). The
reference uses `data-state="working"` / `"validating"`; the production state
contract names these `coding` / `inspecting`, so the component maps
contract → reference internally. Props: `state`, `message`, `motion`,
`showBadge`, `patrol`. Production state comes only from the pure
`derive-clawd-state` layer fed by real snapshot facts. Random/demo cycling is
available **only** in explicit demo mode (`?clawdDemo=1` or dev config).

Preserved exactly: first-paint flicker protection (`booting` → `is-ready` on
rAF), all-props-hidden-by-default with per-state reveal, overlap-protection CSS
vars, state-entry + prop-in transitions, idle-only grounded footer patrol with
turnaround + curiosity, persistent attention/blocked messages, contextual
badges, `prefers-reduced-motion` + explicit motion setting.

The canonical reference file is **never edited** (the package self-test asserts
its state vocabulary) and stays served at `/clawd-playground` as the source of
truth for visual parity checks.

## Real-time transport

**Decision:** SSE for logs and run/validation/review events. No WebSockets -
the panel has no bidirectional terminal.

## Security boundary

Bind `127.0.0.1`. Static serving is allowlisted to `ui/` + the named
reference file, with path canonicalisation and traversal rejection. No arbitrary
filesystem or shell endpoint. Mutating endpoints are a fixed allowlist of named
actions validated against typed schemas, guarded by a same-origin/CSRF check.
Repository strings and logs are escaped before rendering; secret-bearing files
are never served. (Full list: `docs/SECURITY.md`.)
