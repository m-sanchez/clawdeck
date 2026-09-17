# Native Windows and session-management research

Collected on 17 September 2026 for the [Ocelin product review](../../docs/OCELIN-NEXT-RESEARCH.md).

This extends the [September 16 collection](../windows-desktop-2026-09-16/README.md). Nine additional repositories were pinned; 39 files (1,182,887 bytes) were downloaded for inspection. Thirteen selected MIT source/license/document files (91,728 bytes) are preserved here, byte-for-byte. Other files remain external references. Upstream applications were not installed or executed, and none of this code is wired into Ocelin.

[sources.json](sources.json) records each immutable source URL, SHA-256, size, observed license and optional local copy. `localPath: null` means the file is not redistributed in this packet. Source inspection establishes implementation choices, not product reliability or compatibility on this machine.

## Implementation references

| Reference | Entry point examined | Decision for Ocelin |
| --- | --- | --- |
| Taskbar Widgets | [Architecture](upstream/pfcdev__TaskbarWidgets/docs/architecture.md), [private API boundaries](upstream/pfcdev__TaskbarWidgets/docs/windows-private-api-risks.md), [pinned Explorer code](https://github.com/pfcdev/TaskbarWidgets/blob/c49721cc1cfcdd53d6ad42226410148153c38055/src/native/taskbar-hook/taskbar_widgets_hook.cpp#L9383) | Keep collectors outside Explorer. Retain only an optional host integration; investigate the public Windows Tasks API first. |
| sessions-search | [FTS5 schema](upstream/luckeyfaraday__sessions-search/sessions_search/db.py), [incremental indexer](upstream/luckeyfaraday__sessions-search/sessions_search/indexer.py) | Derived search index with snippets; adapt to bounded updates and provider-qualified identities. Do not copy its full-message replacement strategy for huge active logs. |
| agentic-session-explorer | [Operation service](upstream/junxit__agentic-session-explorer/src/sx/service.py), `session_is_active`, `DeleteService.preview`, operation log | Useful scope preview and result patterns. Use native lifecycle contracts; do not treat an activity timeout as permission to delete. |
| CCManager | [SessionRestoreStore](upstream/kbwo__ccmanager/src/services/sessionRestoreStore.ts), `ownerPid`, `record`, `forget` | Preserve exact native ID and launch ownership; distinguish restarting a command from resuming a conversation. |
| ccmux | [Notification actions](upstream/epilande__ccmux/src/daemon/notification-action.ts), [transcript search](upstream/epilande__ccmux/src/daemon/transcript-search.ts) | Scope action IDs and reject stale requests. Ocelin's initial notification action opens the owner instead of injecting approval keystrokes. |
| Maestro | [Quick resume](https://github.com/RunMaestro/Maestro/blob/290253d288b5d4f89ecddc658259f2624871790c/src/renderer/components/AgentSessionsBrowser/hooks/useAgentSessionsResume.ts#L49), [search](https://github.com/RunMaestro/Maestro/blob/290253d288b5d4f89ecddc658259f2624871790c/src/renderer/components/AgentSessionsBrowser/hooks/useAgentSessionsSearch.ts#L28) | Separate inspection from direct resume; title search can be immediate while transcript search is cancellable. AGPL reference only; no code copied here. |
| cmux | [Codex resume validation](https://github.com/manaflow-ai/cmux/blob/3773d55f41fa0f8fb2f6c8e588e4cc7862cb099b/CLI/CMUXCLI+CodexResumeBindingVerification.swift#L50), [notification policy](https://github.com/manaflow-ai/cmux/blob/3773d55f41fa0f8fb2f6c8e588e4cc7862cb099b/CLI/AgentHookNotificationPolicy.swift#L10) | Check identity at dispatch, preserve attention ownership. GPL reference only; macOS code is not a Windows implementation. |
| TrafficMonitor | [Windows 11 placement](https://github.com/zhongyang219/TrafficMonitor/blob/188b8773b959733bfc0e4f506c762d9a255883d4/TrafficMonitor/Win11TaskbarDlg.cpp#L5) | Test alignment, system widgets and secondary monitors. Current Anti-996 license; no source copied here. |
| Windhawk AI usage | [CreateOverlay](https://github.com/ovenmakemeheat/windhawk-taskbar-ai-usage/blob/11e5256963557968022ac17b5b8fc1535d7e3acd/mods/taskbar-left-text.wh.cpp#L759) | This is a popup overlay, not an example of Microsoft's app-task contract. Preserve that distinction when describing native integration. |

## Read-only local checks

[capabilities.json](capabilities.json) contains redacted results. No titles, task IDs, prompts, credentials or account identifiers are included.

- Windows 11 25H2, build 26200.9457: task type present and `AppTaskInfo.IsSupported()` true. No task created; actual rendering remains a prototype gate.
- Codex CLI 0.153.2: initialized an independent app-server; `thread/list` with `useStateDbOnly: true` returned ten entries; metadata read succeeded; `thread/turns/list` returned two summaries. `thread/loaded/list` was empty. No resume, turn, archive or delete request was sent.
- The generated installed protocol includes archive/unarchive/delete. Method presence is not proof of native Desktop lifecycle synchronization.
- The daemon version command reports that daemon lifecycle is Unix-only. This is not a Windows Desktop attachment path.
- Installed Codex Desktop 26.908.4834.0 registers the `codex` protocol. Read-only inspection found its thread-ID route in `.vite/build/window-all-closed-BxbCP6YG.js` around character 556479 and the parser in `src-CCXHtyvY.js` around 454896. This is version-specific implementation evidence, not a stable public contract or an end-to-end navigation test.
- Node 24.9.0 built-in SQLite accepted an in-memory FTS5 table. The packaged runtime was not tested for this capability.

Run the Windows availability check using Windows PowerShell 5.1:

```powershell
& "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -File research/windows-integration-2026-09-17/probe-taskbar.ps1
```

The probe only queries platform availability. It does not create shell tasks, register packages, install extensions, restart Explorer or change application history. A positive result must not be presented as proof that an Ocelin task has appeared in the taskbar.

For the Codex read-only check, use the installed CLI's `app-server --stdio`, initialize a research client, and call `thread/list`, `thread/loaded/list`, `thread/read` with `includeTurns: false`, then `thread/turns/list`. Use a small page size, avoid logging returned content, and stop only the process started for the probe. The live app's server was not stopped or attached to.

## Reuse boundaries

All local upstream files retain their original contents and MIT notices. The project's license does not replace those notices. Git attributes preserve upstream bytes, including original whitespace. Other licenses and proprietary installed-app inspection are documented as references; their implementation code is not imported. Provider logos retain their existing separate attribution. This packet is outside the npm package's runtime file allowlist.

No native cleanup was performed. Existing private Session Doctor findings informed the distinction between native history, metadata-only entries, missing workspaces, recovery copies and shared snapshots. Those private records are not part of this packet.
