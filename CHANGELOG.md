# Changelog

## 0.3.0

Three flagship features plus security and test-coverage hardening. Several
boundaries the README named were previously unproven or inconsistent; this
release closes them and pins each with a test against the real server.

### Features

- **Trace waterfall** (Activity > Trace). Every turn of a session rendered
  as tool-call spans with real durations, paired from the transcript
  (`tool_use` ↔ `tool_result`). Token counts are deduplicated per request;
  human-wait spans (plan approval, questions) are width-capped and dashed;
  a dead session's unfinished tools render as incomplete, never as
  running. Bounded backward read (4 MB budget) keeps 200 MB transcripts
  fast.
- **Burn rate + limit forecast** (Cost). A one-minute sampler differences
  each session's cumulative statusline cost into persisted history;
  the Cost hub gains $/hour, 5h/7d depletion slopes with ETA (computed
  within one reset epoch only), and a monthly projection gated on six
  hours of coverage. Cost and quota provenance are reported separately.
- **Ask Clawdeck** (Prompt). One-question chat answered by a local
  `claude -p` child running tool-less in a sterile temp directory with an
  allowlisted environment and no settings/MCP loaded; the only context
  sent is a compact snapshot summary that is secret-scanned fail-closed.

- **Live pulse strip** (Overview). The last five minutes of panel events
  as breathing five-second bars, updated every second client-side.
- **Host vitals** (Health). CPU (delta-sampled), memory, and the observed
  checkout's disk volume as threshold-toned meters; unmeasurable values
  report n/a, never zero.
- **Collapsible cards**, persisted per browser.
- **Forge connectors for Bitbucket Cloud, Gitea/Forgejo and Azure
  DevOps**, joining GitHub and GitLab behind the same auto-detected,
  read-only, normalized status shape.
- **Trace span tooltips**. Hover or keyboard-focus a span row to see the
  full story: tool, status, duration, subagent description or input
  summary. Escape dismisses.
- **Keyboard & small-screen polish**. Hub tabs follow the WAI-ARIA tabs
  pattern (arrow keys, Home/End, focus retained); trace turns and card
  collapses announce their expanded state; host vitals are real meters to
  assistive tech; a shared focus ring covers every control. The layout no
  longer overflows narrow viewports (~420px): the single-column shell,
  topbar and checkout pill all shrink instead of widening the page.
- **Dirty-section re-render + snapshot revalidation**. The snapshot now
  carries per-section content hashes; auto-refreshing views declare which
  sections they read and skip the re-render when none changed (skip counts
  in Health). /api/snapshot answers 304 to a matching ETag, and the SPA
  revalidates on tab focus - cheap freshness after the machine slept
  through the SSE stream.
- **Config map with usage overlay** (Configuration). Everything the
  checkout declares to Claude Code - rules, commands, skills, agents,
  MCP servers, hooks - correlated with what recent sessions actually
  invoked. Dead config renders dim; calls resolved from global/user/plugin
  config are surfaced separately.
- **MCP & skills analytics** (Cost). Which MCP servers and skills recent
  sessions actually called - counts, error rates, median durations - from
  bounded transcript tails. No other Claude Code tool reports this.

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
  argv and an expansion/line-break guard (`"`, `%`, CR, LF rejected).
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
