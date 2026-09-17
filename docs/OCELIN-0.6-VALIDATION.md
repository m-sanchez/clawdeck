# Ocelin 0.6 integration preview

This implements the next session-management slice from the [native integration research](OCELIN-NEXT-RESEARCH.md). It is a Windows preview, with explicit provider and shell limitations.

## Implemented paths

- **Now:** compact project groups, provider icons, running/attention status and measured app memory. Old discovered records no longer populate the first screen.
- **Peek:** hover or keyboard-focus a conversation to read its latest request, response and recent tools. Codex paginated history uses the installed CLI's native history API. A missing project folder does not block a preview.
- **Continue:** click opens the exact `codex://threads/<id>` or `claude://resume?session=<id>` route. Notification clicks use the same dispatch. Known archived Claude conversations are labelled “restore and open.”
- **History:** independent, paginated library with search by title, first request, project and ID; provider/age/missing-folder filters; explicit selection and reviewed actions. It includes Codex archives and joins Claude Desktop titles/archive metadata.
- **Cleanup:** reversible Ocelin hide/show for both providers, and Codex native archive/restore through app-server. No direct provider database writes or permanent deletion. Native archive refuses active, recently modified or unconfirmed tasks; checks provider-home identity and descendant scope; revalidates the selection before applying.
- **Windows:** registered activation protocol, notification routing, jump-list entry, Ctrl Alt O quick panel, selectable native App Tasks bridge and selectable Taskbar Widgets strip. The strip can open Ocelin when clicked. Its host permission review remains user-controlled.
- **Resources:** the monitor and library share the desktop process through worker threads; hidden windows release their renderers after 30 seconds. Provider API connections close when idle. Shared app memory is not represented as per-session RAM.

## Evidence

- Package self-test passed.
- Full core suite: 690 tests passed. Regression coverage includes mixed parent/child archive ordering, provider-home identity, Windows extended paths, native activity dates, and reconnecting a stopped taskbar helper.
- Packaged 0.6.0 desktop smoke passed native URI construction/dispatch, history, keyboard-focus preview, hide/restore through IPC, official icons, project routing/reopening, sign-in startup restoration, settings, sandboxing and 320/420/700-pixel layouts. URI dispatch checks do not prove external provider rendering.
- Installed Codex CLI 0.153.2 successfully archived and restored an isolated fixture through its real API, with no model turn and no real-user history changes.
- Read-only live library probe indexed 884 distinct conversations, including 203 archived/hidden records, and read a paginated Codex preview through the native API. Indexing plus first native preview took about 7 seconds in the final cached probe on this machine; this is not an instant cold-start guarantee.
- Taskbar Widgets 0.5.36's `twdev validate` accepted the 0.6.0 widget package, including its Ocelin-open button. Explorer placement requires the optional host and its permission review.
- Native App Tasks package compilation and registration were checked on Windows 11 build 26200.9457. The first runtime check exposed a null/empty collection issue; a corrected 0.6.0.1 package is prepared for the next native rendering check.

## Remaining limits

The public Windows App Tasks API is experimental and needs an enabled Windows rollout plus package identity. The local MSIX is an unsigned development package; production signing is separate. The Taskbar Widgets host uses private Windows APIs and is optional. Native shell rendering must not be inferred from schema/protocol checks.

Claude's supported local integration does not expose a general native archive API. Ocelin offers local hiding and native reopening; it does not edit Claude's private descriptors. Agent approvals remain in the owning app. An independent Codex app-server is used for saved history and lifecycle operations, not as a claimed attachment to Desktop's running process.

History previews are bounded, and search covers metadata and first requests rather than complete transcript full-text. The current app remains Electron-based; the research's 150 MiB idle target has not been demonstrated. WSL, remote-only sessions and a full physical multi-monitor/DPI/sleep matrix remain outside this validation.
