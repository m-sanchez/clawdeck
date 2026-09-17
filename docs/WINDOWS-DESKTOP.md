# Ocelin for Windows

Ocelin is the new product and mascot identity for Clawdeck. The existing repository URL, npm package, launcher commands, configuration keys, session stores, and canonical Clawd reference remain compatible.

## Install and run

Use the x64 Windows installer from [Releases](https://github.com/m-sanchez/clawdeck/releases). The 0.6 integration preview is unsigned. It installs for the current user and includes Chromium and Node; no system Node installation is needed to run it. Startup at sign-in is off until enabled in settings. Updates are manual through Releases; Ocelin never downloads or executes an update in the background.

For development, install Node 22.12 or newer, run `npm ci` inside `desktop/`, then `npm start`. `npm run pack` produces an unpacked app; `npm run dist` produces the NSIS installer. The browser core continues to need only Node 20 or newer and no runtime npm dependencies.

## Choose your surfaces

- **Windows tray:** running and attention counts, a quick panel, and a menu to reopen windows or quit.
- **Floating bar:** compact session chips or a status tile with running counts and app RAM; move freely or anchor above the Windows taskbar.
- **Dashboard:** active sessions first, collapsible project groups, provider symbols, live app RAM and searchable history; hover to preview a conversation, click to continue in its provider, or use the secondary project dashboard action for feed, trace, worktrees, reviews, cost and delivery views.

All three share one collector and notification owner. Closing a window hides it. Explicit Quit stops Ocelin's monitor and project backend, without stopping Codex or Claude. Ocelin retains a recovery surface when every option is switched off. Display changes clamp saved window positions to an available work area. Relaunching a second instance brings back the dashboard.

Preferences, checkpoints, notification history and acknowledgements live in `%LOCALAPPDATA%\Ocelin`. Provider transcripts stay where their provider wrote them. The monitor saves metadata and file offsets. The separate history index caches titles and bounded first-request text locally; previews read provider history on demand. Saved native task names, session IDs and project paths are local metadata. Uninstall preserves these preferences so reinstalling is reversible.

## Sources and state

### Keep the first screen useful

The **Now** view shows recent running and attention signals, grouped by project. Collapse a project or all projects to scan the list. **History** and **Archived & hidden** use a separate, paginated library. Search titles, first requests, projects and IDs; filter by provider, age or missing folder. A discovered transcript is not a running process.

Hover or keyboard-focus a conversation to preview recent text without opening another screen. Click it to continue in the exact provider task. Codex paginated sessions use the native history API. Known archived Claude tasks are labelled as restoring when opened. Project dashboards and folders remain secondary actions.

Select conversations to preview **Hide in Ocelin**, **Show again**, **Archive in Codex** or **Restore in Codex**. Hiding is local visibility only. Native archive requires the Codex CLI, confirmed completion and validated child-task scope. It preserves original history and frees no disk space. Claude native archive and permanent deletion are not offered.

Under **Settings → Session history**, **Clear older sessions from view** hides finished and stale entries up to that moment. Active work stays visible. New activity brings a session back; **Show older sessions again** restores the view. This does not delete provider conversations or modify their history.

RAM cards show private working set for each app and its recognized child tools. Click a card for process names, PIDs and CPU. Ocelin measures every 12 seconds with one hidden Windows helper; inaccessible or stale measurements stay unavailable. Shared desktop memory is not divided between projects or sessions.

### Taskbar choices

Enable the floating bar, choose **Compact status tile**, then **Above Windows taskbar** for the built-in readout. Drag the mascot to move it; dragging releases the taskbar anchor and remembers its position. Its hide button keeps it hidden across settings changes and restarts. Restore it from the tray's **Toggle floating bar** or Settings. Both layouts remain selectable.

For native Windows hover cards, install the separate [App Tasks development bridge](../desktop/native/README.md) and enable **Native Windows hover cards (experimental)**. This uses Microsoft's public, experimental API and reports whether Windows stores the tasks. Storage is distinct from visible rendering. It needs a supported Windows rollout and package identity.

For a persistent text strip inside the taskbar, enable **Share counts and RAM with the taskbar text strip** and choose **Connect taskbar strip**. Follow the [integration guide](../desktop/integrations/taskbar-widgets/README.md) to install the optional host and review its permissions. This host uses private Windows APIs; Ocelin does not grant its permissions. Only aggregate counts, RAM and the system light/dark theme are shared locally. Both native cards and the strip are selectable.

If a widget update reports **os error 32** or **Installed widget could not be staged for update**, choose **Quit** in Ocelin's tray menu, reopen the installed Ocelin from the Start menu, then review the update again in Taskbar Widgets Settings. An older URI launch could leave Ocelin and its helpers using the widget folder as their working directory, blocking Windows from renaming it. Version 0.6.2 uses stable data directories for the app, provider and URI launch. The host's permission review still applies.

Default discovery reads `%CODEX_HOME%\sessions` (or `~/.codex/sessions`) and `%CLAUDE_CONFIG_DIR%\projects` (or `~/.claude/projects`). Add additional local source folders from Settings. Claude Desktop metadata is joined by `cliSessionId`, not by matching project names. Subagents carry parent identity when present. Codex's optional `session_index.jsonl` supplies native task names.

Live monitoring is bounded to 2,000 recent transcript files per source, selected by modification time from at most 20,000 entries. Settings reports a reached limit. Historical entries older than 30 days are pruned from Ocelin's metadata. Reconciliation runs approximately every 30 seconds; active files are incrementally read on a three-second cycle after the previous cycle finishes. Initial discovery of a large history takes longer. Checkpoints restore the last known state while reconciliation runs. The separate history library includes older and archived conversations, scans up to 100,000 files per source, and returns at most 100 entries per page. Its search covers metadata and first requests, not full transcript text.

| Signal | Meaning |
| --- | --- |
| Lifecycle hook | A locally received provider lifecycle event |
| Transcript inference | State inferred from local records; not a provider status API |
| Stale activity | No update for 15 minutes; outcome remains unknown |
| Turn finished | An explicit observed end of a response, not proof an entire task is complete |
| Seen | Acknowledges this signal without changing the agent's execution state |

Late events for an older known turn cannot finish a newer turn. Notification identities and acknowledgements survive restart. Historical events do not generate a notification storm. Quiet mode, provider/project muting, optional completion notices and sound settings apply at the shared notification owner. Windows notification policy also applies.

## Optional hooks

Settings previews the exact hook groups before any write. Applying creates a backup and preserves unrelated hooks and settings. Remove uses the recorded command ownership list and removes only Ocelin handlers. A changed configuration invalidates an older preview. The capture process writes only session ID, cwd, timestamp, turn ID when available and lifecycle state, with bounded input and a short timeout.

Codex stores these in its home `hooks.json`; Claude uses its home `settings.json`. **Codex requires review and trust through `/hooks` before new hooks run.** Existing sessions may need restarting. The app cannot grant hook trust on your behalf. Remove the integrations in Ocelin before uninstalling if you enabled them. Backups are in Ocelin's `hooks` data directory; selective removal is preferable to restoring an entire older provider configuration.

Installed versions inspected during development: Codex CLI 0.153.2, Claude Code 2.1.260, Electron 44.4.1. Transcript formats can change. Diagnostics show source availability and the time of the last actual hook received; merely installing hooks does not imply live coverage.

| Host | Local transcript monitoring | Optional lifecycle coverage | Return navigation |
| --- | --- | --- | --- |
| Codex CLI / native Codex local tasks | Implemented | Session, prompt, tool, permission, stop, interrupt; provider trust required | Exact conversation in the installed provider Desktop app; project feed and folder as secondary actions |
| Claude Code CLI | Implemented | Session, prompt, tool, permission, stop, failure, permission notification | Exact conversation in the installed provider Desktop app; project feed and folder as secondary actions |
| Claude Desktop Code local sessions | Implemented when a local CLI transcript exists | Depends on the host loading the configured hooks; last-received diagnostic is authoritative | Exact conversation in the installed provider Desktop app; project feed and folder as secondary actions |
| WSL, remote/cloud-only sessions | Not included | Not included | Not included |

Exact native task routes are dispatched to the owning Desktop app. Claude's resume route may restore a natively archived task, which is labelled when that metadata is available. Ocelin does not click approval buttons or synthesize keystrokes in either provider. Ctrl Alt O opens the quick panel; notification clicks return to their specific conversation.

## Boundaries and packaging

The desktop package is isolated under `desktop/`; the core server and UI still use built-ins only. Sandboxed renderers have no Node access. IPC validates the window, frame, action and arguments. Folder/project actions resolve known session IDs, rather than accept arbitrary paths from a renderer. Navigation is restricted. The existing backend stays token-gated and bound to `127.0.0.1` with strict Host validation. A selected project starts one owned utility-process backend; no project backends or git polling are started for the global tray/bar monitor.

The monitor and history library use worker threads in the desktop process. A selected project backend uses Electron's bundled Node mode. Hidden windows release their renderers after 30 seconds. Ocelin owns only the workers and utility processes it starts and never stops a standalone dashboard. The approved Ocelin art extends the original state/motion implementation; the canonical Clawd reference remains unchanged.

## Validation and preview limits

Automated coverage includes independent providers and sessions, late turn events, partial UTF-8 records, growth with unchanged mtime, truncation/rotation, checkpoint recovery, notification deduplication, privacy filtering, selective hook install/removal and stale previews, all surface combinations, and offscreen placement recovery. Existing HTTP authorization, checkout scoping and Codex feed/trace tests remain required.

Native Windows and packaged-build results are recorded in the [0.6 validation notes](OCELIN-0.6-VALIDATION.md). Signing requires a release certificate. The user confirmed the optional 0.6.1 text strip inside the taskbar. Adapter 0.6.2 displays counts and RAM; adapter 0.6.3 fixes redirected pet image paths and awaits visual confirmation in Explorer; native Windows hover cards also remain visually unverified. WSL, remote sources, reserved-edge AppBar mode, direct approvals and automatic updates remain outside this preview. A complete physical multi-monitor, sleep/lock, and 100/125/150/200% DPI matrix still needs hardware coverage; unit-tested placement recovery is not a substitute for that matrix.

## Sources and attribution

Provider icons come from the official installed Codex Windows app and Anthropic's official Claude Code extension. Their original colors and geometry are preserved, including supplied Codex light/dark variants. [Asset sources and ownership](../desktop/renderer/vendor/ATTRIBUTION.md).

The research and licensed reference extracts are in [Windows research](WINDOWS-DESKTOP-RESEARCH.md) and `research/windows-desktop-2026-09-16/`. The desktop implementation is written for this repository; external reference code has not been pasted into the runtime.

Primary integration references: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude hooks](https://code.claude.com/docs/en/hooks), [Electron utility processes](https://www.electronjs.org/docs/latest/api/utility-process), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).
