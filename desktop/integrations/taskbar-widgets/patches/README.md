# English permission review and host fixes

This optional host build uses [Taskbar Widgets 0.5.36](https://github.com/pfcdev/TaskbarWidgets/tree/c49721cc1cfcdd53d6ad42226410148153c38055), under its MIT license. It is an Ocelin-maintained patch, not an upstream release.

The patch translates the installer's hardcoded Turkish permission and installation text into English. Permission requests, risk levels, package validation and the user's approval controls are unchanged. Ocelin does not preapprove grants.

After an approved installation, the host starts its runtime and waits for the exact installed widget to appear in the refreshed catalog before enabling it. Upstream can otherwise enable its first built-in widget when the runtime was stopped. A separate patch removes the unrelated Antigravity keyboard-shortcut write at host startup; explicit IDE actions retain their existing behavior.

The native primary-action patch lets a native widget without an expanded layout declare a root `layout.action`. A click sends that provider action with the actual widget instance ID; action names use the process provider's existing validation rules. Dragging, nested buttons, right-click Settings and expanded widgets retain their behavior. The user confirmed Ocelin adapter 0.6.3's pet is visible; adapter 0.6.4 removes the separate glyph button and uses this whole-widget action, which still awaits a live click check.

The GitHub `Optional taskbar host` workflow builds from the pinned source and includes the upstream license and third-party notices. Both Settings and the loader are rebuilt because the loader embeds Settings and otherwise restores its original executable.

The pinned upstream Cargo lockfile still labels its own Settings package as 0.5.21 while its manifest is 0.5.36. The build aligns that one version before compiling, then requires the lockfile hash to remain unchanged. Dependency versions and checksums are preserved.

The host remains optional and uses private Windows taskbar APIs. Its installer requires user review before enabling Ocelin's process provider. The normal Ocelin companion works without this host.
