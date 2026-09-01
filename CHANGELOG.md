# Changelog

## Unreleased

### Git + Claude Workbench

The Delivery hub becomes a workbench: what blocks the change, why, and what to
do about it - without Clawdeck ever writing to a forge.

- **Review Inbox.** GitHub and GitLab discussions imported read-only, with
  deterministic thread ids, two coverage axes (threads listed vs resolutions
  read), anchor-aware line mapping, and a derived state that always carries its
  own evidence. `REMOTE_RESOLVED` is reachable only from the provider saying so.
- **Fix locally.** One review comment or one failing check becomes a scoped
  task. The brief is written to a file and secret-scanned first; the deep link
  carries only the task id, that path, and a correlation marker. Nothing
  launches: the human submits the prompt, and the marker is what binds the
  session - a time window only nominates candidates.
- **Task lifecycle, separate from outcome.** `CREATED` starts no watchdog,
  `SETTLED` requires a captured result, and correctly concluding the reviewer is
  wrong settles as `NO_CHANGE_RECOMMENDED`. Idleness never implies completion.
- **CI as a positive fact.** Read for the commit the change is on, across
  check-runs and commit statuses, so an all-green Actions run beside a failing
  external context reports failing. An incomplete read is `unknown`; an empty
  failure list is never, by itself, green.
- **Job output and attribution.** Failing jobs offer a bounded, secret-scanned
  log tail behind a token-gated route that refuses any job outside this
  commit's read. Attribution defaults to "no reliable attribution" and names a
  task only when a marker-bound task changed a file the job itself named.
- **Two-axis readiness.** `remoteMerge` and `localDelivery`, each
  `READY | BLOCKED | UNKNOWN`. Stale evidence can be displayed but can never
  mint READY, and a change with no open PR is UNKNOWN rather than ready.
- **Attention Inbox.** What needs a person, kept apart from what blocks
  delivery. Advisory output cannot enter it: there is no argument that puts a
  suggestion in the authoritative list, and "Add to attention" records the
  engineer's decision with the assist kept as provenance.
- **Decision ledger, fix lanes, wait telemetry.** A decision's authority must be
  stated and can only be human or mechanical policy; lanes group tasks only by
  mechanical overlap and show the overlap; waits are measured between recorded
  transitions, so thinking time is never reported as waste.

- **GitHub credentials from the `gh` CLI.** When neither the environment nor
  `settings.local.json` holds a `GITHUB_TOKEN`, Clawdeck asks the already
  signed-in `gh` CLI, cached, GitHub-only, and skippable with
  `CLAWDECK_NO_GH_CLI`. Without it, job-log reads answer 403 for most people.

### Fixed

- The uncommitted-file count read the dirty flag rather than the count, so any
  dirty tree reported exactly one file.
- The delivery lifecycle called CI green from the branch's latest run even when
  local commits had not been pushed - that run belongs to a different commit.
- A GitHub review anchor could be double-mapped by pairing a current line with
  an original commit, moving a comment to the wrong line. Found on a live PR.


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
- **Layout pass across the hubs**. Health, Cost and Prompt now masonry-pack
  their cards, so short cards stop leaving holes under tall ones; delivery
  stages and prompt context toggles keep even widths when they wrap; card
  grids wrap instead of stretching before layout runs.
- **Fix locally, with traceability** (Delivery → Inbox). A review thread can be
  handed to Claude as a scoped task: the brief is written to a file and the
  deep link carries only the task id, that path and a correlation marker, so no
  review text reaches a URL. Nothing is launched - the prompt is prefilled and
  the task waits until you submit it, at which point the marker binds it to the
  session that ran it. Each thread then shows the chain it caused: task,
  session, files, commit, tests, and the remote state, which still reads
  "reply not posted, thread unresolved" no matter how green the rest looks.
- **Agent tree** (Activity). The subagents a session spawned, nested by who
  spawned whom, with each agent's own closing report quoted verbatim and
  labelled as its own words. An agent is linked to a parent only when a
  transcript actually contains the Task call that created it; anything
  unprovable is listed as unattributed rather than guessed into the tree.
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
