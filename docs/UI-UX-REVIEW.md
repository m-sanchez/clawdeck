# Ocelin UI review: September 17, 2026

This records the 0.5 visual changes. The subsequent [native integration and session-management review](OCELIN-NEXT-RESEARCH.md) identifies unresolved product gaps and supersedes this document's next-step recommendations. The history cutoff below is a visibility filter, not native archive or storage cleanup.

The operator's first question is “what needs me, what is running, and what is using RAM?” The 0.4 landing screen spent too much space on branding and exposed a historical transcript count as its main inventory. The website can introduce the product; the installed app should get to the work immediately.

| Finding | Change in 0.5 |
| --- | --- |
| Large welcome section above the first session | Compact header and inline running/attention/project counts |
| 2,398 discovered transcripts looked like live agents | Active now is the default; historical totals are removed from the summary |
| Repeated cards and four buttons per session | Collapsible project groups, compact rows, one primary action and a details menu |
| Provider identity required reading text on every row | Official provider icons with accessible names and tooltips |
| Identical amber status dots | Green running, amber attention diamond, completion check and hollow unknown marker, alongside text |
| No resource visibility | App RAM totals at the top, with process/PID/CPU details one click away |
| No way to clear old results | Reversible history cutoff; active work stays visible and new activity restores older sessions |
| Bar competed with the work | Compact session chips or a small status tile; movable or anchored above the taskbar |
| No inside-taskbar option | Optional Taskbar Widgets package, explicit sharing switch and export/setup controls |
| Refresh could disrupt navigation | Project collapse and actions remembered, focus restored by session identity |

## Memory and activity

Running status comes from provider activity. RAM is measured from live Windows processes using `GetProcessMemoryInfo` and `PROCESS_MEMORY_COUNTERS_EX2.PrivateWorkingSetSize`, every 12 seconds. CPU uses changes in cumulative process CPU time, normalized across logical processors. Inaccessible memory stays unavailable. Parent creation times guard against PID reuse during process-tree attribution.

Provider totals include recognized Codex/Claude processes and their child tools. Ocelin reports its own processes too. Desktop apps share infrastructure across sessions, so shared RAM is not divided into invented per-project or per-session numbers. Generic runtimes without an identifiable provider ancestor may not be attributed. Measurements are not added to the transcript checkpoint store.

## Taskbar choices

The built-in tile belongs to Ocelin and sits above the Windows taskbar. It displays activity counts and combined Codex/Claude RAM without third-party software.

The optional `.twidget` package uses the native renderer in [Taskbar Widgets](https://github.com/pfcdev/TaskbarWidgets), whose host uses private Windows XAML integration. The package reads a small, opt-in local summary without session titles, IDs, paths, account data or prompts. It becomes offline after 35 seconds without an update. It has no network listener or agent-control endpoint.

The host requires review of a broad permission for process providers. Ocelin exports the package; it does not silently install an Explorer extension or grant that permission. Protocol and package checks do not prove Explorer rendering on a host that has not been installed and approved. [Setup and permission details](../desktop/integrations/taskbar-widgets/README.md).

Microsoft's supported [Windows Widgets](https://learn.microsoft.com/en-us/windows/apps/design/widgets/) live in the Widgets board, a different surface from a persistent custom taskbar readout. The direct taskbar integration is experimental.

## Acceptance checks

- Active-first view, project grouping, collapse persistence and reversible history cleanup.
- Provider and status indicators understandable without color alone, keyboard-accessible controls and preserved focus.
- Dashboard, tray, bar and status tile without horizontal page overflow at supported sizes.
- Actual Windows RAM from the packaged app without system Node.
- Widget protocol updates while stdin is idle, marks stale data offline and exits on shutdown.
- Core tests, package self-test and native desktop smoke checks.

Physical mixed-DPI/monitor hot-plug, screen-reader speech, Explorer-host rendering and extended idle resource measurements remain separate coverage limits.

Memory reference: [Microsoft process memory counters](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex2).
