# Dashboard specification

## Product goal

The panel is an operator console for starting, supervising, understanding and finishing Claude engineering work in the current checkout or worktree.

## Primary lifecycle

```text
Describe task
→ choose workflow
→ prepare checkout/worktree
→ launch
→ supervise
→ intervene if required
→ validate
→ review
→ finish/handoff
```

## Overview hierarchy

1. Needs attention
2. Active runs
3. Selected run summary
4. Worktree/service health
5. Validation and review status
6. Recent logs/events

Avoid placing every capability in equal-weight cards.

## Required views

### Overview

- checkout and branch
- panel and agent health
- needs-attention queue
- active runs
- quick task launch
- selected run status
- Clawd mapped to selected/priority state

### Runs

- filters by running, waiting, blocked, completed
- run title, branch, phase, elapsed time, last activity
- pause/resume/cancel/retry only where safe
- run detail tabs or sections

### Run details

- execution timeline
- changed files/summary
- validation evidence
- review findings
- logs
- permissions or decisions requested

### Worktrees

- branch/path
- owned services and ports
- process health
- validation state
- last activity
- safe start/stop/open actions

### Validation

- affected projects
- format, lint, typecheck, tests, build
- blocking vs advisory findings
- exact command/evidence where available

### Reviews

- findings by severity
- exact-state/commit marker
- resolved/open status
- readiness based on concrete evidence, not an unexplained score

### Logs

- live SSE stream
- run/service filtering
- pause/autoscroll
- safe copy/download where appropriate
- bounded retention in the browser

### Configuration

- motion level
- message/badge behaviour
- browser opening
- demo mode in development only
- service integration preferences

## Task launcher

Collect:

- task description
- workflow type
- repository/project
- base branch
- existing/new worktree
- permission mode
- validation profile
- issue/MR reference
- final command/plan preview

## Accessibility

- real headings and landmarks
- keyboard navigation
- focus trapping in dialogs
- status updates through appropriate live regions
- colour is not the only status signal
- Clawd messages have textual equivalents
- reduced motion is fully supported
