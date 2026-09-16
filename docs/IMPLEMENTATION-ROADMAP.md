# Ocelin delivery tracker

Approved scope: native Windows monitoring for Codex and Claude, with independently selectable tray, floating bar, and dashboard; the approved golden pixel ocelot; compatible browser operation; GitHub and personal website updates.

| Stage | Deliverable | Status |
| --- | --- | --- |
| Compatibility | Installed provider matrix, isolated Electron package, bundled Node backend | Packaged Windows x64 smoke passed; exact native task links remain unavailable |
| Monitor | Global discovery, independent sessions, incremental reads, lifecycle evidence, durable acknowledgement, optional hooks | Implemented; fixtures and live local discovery verified |
| Tray | Single owner, attention summary, notification preferences, diagnostics | Implemented; native panel and packaged smoke verified |
| Floating bar | Session chips, overflow, density, position recovery, reduced motion | Implemented; native controls, rendered output and packaged smoke verified |
| Dashboard | Existing project views, global selection, shared monitor, Ocelin identity | Implemented; selected-project backend and session route verified |
| Release | Per-user installer, startup setting, lifecycle checks, docs, GitHub and website | Windows x64 preview installer and browser archive; GitHub release and website accompany v0.4.0 |

Validation evidence and remaining limits will be recorded in `docs/WINDOWS-DESKTOP.md`. Existing gates remain `node scripts/self-test.mjs` and `npm test`. Desktop adds fixture tests and a packaged Windows smoke check. The historical research remains a proposal record, not release evidence.

Later scope from the accepted research: WSL and remote sources, Explorer embedding, reserved-edge AppBar mode, direct approval controls, and third-party bar integrations.

## Evidence

- Core self-test passed. Unit suite: 669 tests passed. Test discovery is explicitly scoped to source tests so packaged copies cannot accidentally run as tests.
- Development and packaged Electron smoke checks passed with isolated Codex/Claude fixtures in two projects, including a path with spaces and Spanish characters.
- Smoke verified all three rendered surfaces, no page overflow, four mascot limbs, renderer isolation, rejection of unknown session targets, a nonce-verified bundled backend, the selected activity route, and recovery from all-surfaces-off.
- Native Windows UI checks found live Codex and Claude sessions, enabled the floating bar, and opened the project dashboard. Standalone browser mode remains separately validated.
- The per-user installer was installed to a path with spaces and Spanish characters. The installed app passed with system Node removed from PATH. An actual encoded PowerShell hook ran through the bundled runtime, received a permission event, and was selectively removed from fixture configuration. Sign-in startup was enabled, verified, disabled and restored. Uninstall removed the app while preserving fixture transcripts and preferences.
- One short idle sample after the installed smoke test used about 580 MiB of private memory across nine processes with all surfaces and a project dashboard created. The collector read zero unchanged transcript bytes in its measured 1 ms cycle. This is a point-in-time measurement, not a sustained performance budget.
- Website: 18 tests passed; Astro check reported no errors, warnings or hints; production build passed. Interactive pose buttons, four limbs and page overflow were checked in the browser.
- Signing, physical display/sleep/lock matrix coverage and host-approved live hook trust remain explicit preview limitations, not completed gates.
