---
description: Show Clawdeck process, port, health and log status
allowed-tools: Bash
---

Run:

```bash
node "{{PANEL_ROOT}}/scripts/panel-status.mjs"
```

Report the current checkout, branch, service health, URLs, PIDs, ports and log paths. Do not infer health beyond the script output.
