---
description: Start or reopen the Clawdeck for the current checkout
allowed-tools: Bash
---

Start the local Clawdeck for the current checkout by running:

```bash
node "{{PANEL_ROOT}}/scripts/panel-run.mjs"
```

The launcher owns dependency checks, port allocation, process reuse, health checks, logs and browser opening. Do not start duplicate services manually.

After it completes, report the dashboard URL, checkout/branch, service status and runtime log directory. If it fails, inspect the reported log path and explain the specific blocker.
