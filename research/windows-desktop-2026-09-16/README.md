# Windows companion: code and ideas collection

Collected and inspected on 2026-09-16. This pack contains 29 original source and notice files from five projects: 467,516 bytes, pinned to full Git commit IDs. It supports the [Windows desktop plan](../../docs/WINDOWS-DESKTOP-RESEARCH.md) and includes [Spanish naming directions](NAMING.md).

These are selected reference files, not complete applications or runtime dependencies. The upstream programs were not installed or executed. The collection is outside the current npm package's `files` allowlist.

## What to borrow

| Product | Useful implementation | Adaptation for our app |
| --- | --- | --- |
| [Claude Deck](https://github.com/hydropix/claude-deck/tree/26e1195cb98d4a3f0f4901c6150f5610eb2d34cb) | Collapsible desktop strip, project grouping, unread completion markers, dismiss-until-next-update | A floating bar that stays quiet until something changes |
| [AgentBar for Windows](https://github.com/michalstrnadel/AgentBar-Windows/tree/e9afe13d4792b9cf31b28bc87bc7e655c3071103) | Hook-driven session files, attention priority, watcher plus reconciliation, Windows popover placement | Reliable status reduction and attention-first ordering across providers |
| [AgentBar Electron](https://github.com/racase/agentbar/tree/4a175910af8be2b340f40954b6f33182b7f28dec) | Single-instance guard, tray popover, separate dashboard, shared summary cache, login startup | The closest shell reference for wrapping our existing browser UI |
| [CodexMonitor](https://github.com/Dimillian/CodexMonitor/tree/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5) | Notification keys, rate limiting, recent-task tray sync, queued notification navigation | One notification owner and dependable navigation after startup |
| [Codex Usage Monitor](https://github.com/upstream-ray/codex-usage-monitor/tree/5cbe8d7ae9e0a8b15571999d48e656e07f960faf) | Explorer taskbar embedding and recovery after Explorer restarts | Experimental integration reference and concrete Windows failure scenarios |

## Specific source map

Line numbers below refer to the frozen local files. Every file has an immutable upstream permalink and SHA-256 digest in [manifest.json](manifest.json).

| Feature | Local source and entry point | Decision |
| --- | --- | --- |
| Unread and dismiss behavior | [Claude Deck session-view.ps1](upstream/claude-deck/scripts/session-view.ps1), `Set-Seen` at 1256; `Set-Dismissed` at 1270 | Adapt the interaction; store acknowledgements separately from incoming events |
| Collapse and edge choice | Same file, `Set-NearestEdge` at 1781; `Set-Collapsed` at 1791 | Port behavior to the optional floating window |
| Attention-first grouping | Same file, `Refresh-List` at 2541 | Group by canonical project identity; sort groups by their most urgent session |
| Watcher with fallback | [SessionStore.cs](upstream/agentbar-windows/src/AgentBar/Stores/SessionStore.cs), `Start` and `Refresh` | Reuse the watcher-as-hint pattern with a debounced reconciliation pass |
| Provider event mapping | [update.js](upstream/agentbar-windows/scripts/hooks/claude/update.js) and [SessionState.cs](upstream/agentbar-windows/src/AgentBar/Models/SessionState.cs) | Adapt state transitions into our existing normalized event pipeline |
| DPI-aware placement | [PopoverWindow.xaml.cs](upstream/agentbar-windows/src/AgentBar/Tray/PopoverWindow.xaml.cs), `PositionNearTray` at 51 | Use as a Windows geometry cross-check |
| Tray and dashboard lifecycle | [Electron main.cjs](upstream/agentbar-electron/electron/main.cjs), single-instance lock at 26; `createPopover` at 235; `positionPopover` at 324 | Extract a small shell; retain our own data and action APIs |
| Shared data and login setting | Same file, `refreshSummary` at 335; `setAutoLaunch` at 388 | One collector feeds all three surfaces; startup follows the user's setting |
| Notification deduplication | [useAgentResponseRequiredNotifications.ts](upstream/codexmonitor/src/features/notifications/hooks/useAgentResponseRequiredNotifications.ts) | Port request identity and cooldown concepts to a framework-independent queue |
| Recent tasks and navigation | [useTrayRecentThreads.ts](upstream/codexmonitor/src/features/app/hooks/useTrayRecentThreads.ts); [useSystemNotificationThreadLinks.ts](upstream/codexmonitor/src/features/app/hooks/useSystemNotificationThreadLinks.ts) | Debounce visible changes; queue navigation until our dashboard is ready |
| Embedded taskbar experiments | [native_interop.rs](upstream/codex-usage-monitor/src/native_interop.rs), `embed_in_taskbar` at 141; [window.rs](upstream/codex-usage-monitor/src/window.rs), `spawn_taskbar_watchdog` at 247 | Prototype separately after tray and floating bar are reliable |

## What inspection changed

### Claude Deck: keep the quiet interaction

`Set-Dismissed` stores the session's current update value. The next update makes it visible again. This is a useful distinction between acknowledging current activity and permanently hiding a session. Its refresh path also groups projects by urgency and avoids repainting when the visible signature has not changed.

Our acknowledgement key should contain provider, source instance, native session ID, and turn or event revision. Keep it in a separate UI-state store: the original code changes the same session file the producer writes, which would introduce competing writers in our pipeline.

Do not copy its fallback from an unrecognized status to `done`, or its prompt excerpt capture. Our hook store already deliberately excludes raw prompt and tool content. A stopped turn and a completed user goal also need separate meanings.

### AgentBar for Windows: combine events with reconciliation

`SessionStore` responds to filesystem changes and polls every two seconds. It sorts by attention priority and recency, then compares a visible-state signature. This makes useful activity responsive while still recovering from missed watcher events.

The hook sample writes a temporary file before renaming it. Keep that technique for any derived session snapshot, while retaining our durable event spool for history. Its sanitized IDs can collapse distinct inputs into one filename, and `process.ppid` can identify an intermediate shell instead of the actual agent. Use validated provider-qualified identities and corroborated liveness; do not delete historical sessions because an assumed PID is gone.

The collected installer installs hooks automatically and includes a long blocking permission hook. Our first desktop version should observe status and open the source application for decisions. Adapt only the configuration merge concepts into explicit onboarding. The collected popover's keystroke approval behavior is not part of the proposed integration.

### AgentBar Electron: the most direct wrapper reference

The main process owns the tray, cached summary, popover, and dashboard. This is the useful structural match: extend one shared data source to tray, floating bar, and full dashboard, with independent visibility preferences.

Its position calculation clamps horizontal bounds but does not fully clamp vertical bounds. The minimum window height can also exceed a small work area. Recalculate both dimensions and both coordinates after DPI, monitor, and taskbar changes. Add an in-flight guard around collection so slow refreshes cannot overlap.

The same file includes web-cookie extraction and persistence, a renderer-to-`openExternal` handler without a destination allowlist, and startup enabled by default. Those sections are outside the proposed port. The wrapper should use our existing local integration, validate IPC sender and action parameters, and expose startup as a user preference.

### CodexMonitor: notification ownership matters

The notification hook deduplicates by request identity, suppresses notifications while its window is focused, and spaces notifications by 1.5 seconds. Recent-task updates are serialized and debounced. Notification clicks are queued while workspace data and connections become available.

Implement these concepts once in the desktop coordinator so three visible surfaces cannot emit three toasts. Persist bounded deduplication state, separate queued from delivered notifications, and retry failures with a limit. The sampled code records some keys before asynchronous delivery succeeds. Its completion predicate also accepts strings containing `complete`, which includes `incomplete`; use exact supported statuses instead.

The task-link code navigates inside CodexMonitor's own workspace runtime. It is not evidence that arbitrary existing Codex Desktop tasks can be opened through a public deep link. Each provider needs a verified navigation capability, with a clear fallback.

### Codex Usage Monitor: study the failure handling first

The native code locates Explorer taskbar windows and reparents its window using `SetParent`. Its watchdog detects taskbar recreation and includes relaunch throttling. That is evidence of the recovery work required by this integration.

Keep actual Explorer embedding experimental. The regular floating bar can satisfy persistent visibility earlier. Test Explorer restart, secondary monitors, mixed DPI, auto-hide, screen removal, and repeated launch failures before offering an embedded mode.

## How these ideas fit the repository

A further product surfaced during naming research: [LINCE](https://lince.sh/) advertises project grouping, an attention bar, and multi-provider agent control in the terminal. Those are useful additional UX comparisons. No LINCE source is included in this collection, and its advertised Windows support is still planned on the inspected page.

1. Extend [event normalization](../../hooks/lib/event-normalize.cjs), [event schema](../../server/core/events/schema.mjs), and [projection](../../server/core/events/projection.mjs) with provider identity and explicit attention states. Preserve [spool](../../hooks/lib/event-spool.cjs) durability and redaction.
2. Evolve [Claude sessions](../../server/adapters/sessions.mjs) and [Codex sessions](../../server/adapters/codex-sessions.mjs) into a shared, global session index with source-specific adapters. Use individual sessions, not one row per provider or repository.
3. Add a separately packaged desktop shell. Keep the core server and browser UI free of runtime dependencies. Reuse one local backend and a small status projection across every surface.
4. Add acknowledgements, notification ownership, recent-session navigation, and persisted window bounds. Keep tray, floating bar, and dashboard independently selectable, including all three together.
5. Run a real Windows integration pass before optional AppBar or Explorer-embedded experiments. Source inspection alone does not establish upstream runtime quality.

## License and provenance

Each included project's root license is MIT. Original copyright notices and source bytes are retained under `upstream/<project>/`. If code is adapted into application files, carry its applicable attribution and license notice into the shipped third-party notices.

AgentBar for Windows also declares a **CPOL 1.02** dependency, `Hardcodet.NotifyIcon.Wpf`, in its preserved [third-party notices](upstream/agentbar-windows/THIRD_PARTY_NOTICES.md). That dependency's source and binaries are not in this pack. The project's MIT root license does not relabel its dependencies.

[Superset](https://github.com/superset-sh/superset/blob/main/LICENSE.md) remains an idea reference because its inspected root license is Elastic License 2.0. [Runlight](https://github.com/Renaissance-Mind/Runlight/tree/c26d518550386d1e85edf319d250cd0b7c81a0d4) remains an idea reference because no license file was identified in the inspected tree. Neither project's code was collected.

No logos, fonts, sounds, packages, installers, or compiled binaries were collected. The selected upstream files include their existing comments and are intentionally unmodified.

## Reproduction and validation

[sources.json](sources.json) records the selection. [collect.py](collect.py) uses Python's standard library to fetch only the pinned files, checks for the expected license grant, bounds download size, and refuses to overwrite a changed local reference. It does not execute the downloaded code.

Run `python collect.py` from this directory to reproduce the collection. [manifest.json](manifest.json) records each source URL, commit, byte length, and SHA-256 digest. The local `.gitattributes` disables text normalization for the snapshots so Windows checkout conversion does not change those bytes. Hash verification validates collection integrity; these incomplete upstream excerpts have not been built or runtime-tested.
