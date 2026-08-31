---
description: Prepare the current worktree, start its services, then open Clawdeck
allowed-tools: Bash
---

Run:

```bash
node "{{PANEL_ROOT}}/scripts/panel-full.mjs"
```

This command may invoke compatible existing worktree setup/run scripts detected by the panel configuration before starting the panel. It must preserve existing process ownership rules.

Report what was started, the dashboard URL, and any worktree lifecycle scripts that were not detected.
