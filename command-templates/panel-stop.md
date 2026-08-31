---
description: Stop only Clawdeck processes owned by the current checkout
allowed-tools: Bash
---

Run:

```bash
node "{{PANEL_ROOT}}/scripts/panel-stop.mjs"
```

Stop only processes recorded in this checkout's panel registry. Report which services stopped and where logs remain.
