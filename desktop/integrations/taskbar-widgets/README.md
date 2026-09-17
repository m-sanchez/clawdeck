# Ocelin inside the Windows taskbar

This optional adapter uses Taskbar Widgets 0.5.36's schema v4 native renderer. Clicking the whole widget requires the [native primary-action patch](patches/native-primary-action.patch) in Ocelin's optional host build. The host uses private Windows XAML integration and may stop working after Windows updates. It is independent of Ocelin's built-in tile above the taskbar.

Adapter 0.6.4 adds a whole-widget action for the right-edge session panel, following 0.6.3's pet asset-path fix. It is versioned independently of the desktop's unreleased 0.6.2 draft. Upgrade the adapter through the host's normal package review; install the patched host separately if it does not yet support the primary action.

1. Install the [patched Taskbar Widgets host](patches/README.md) if you want its experimental Explorer integration and whole-widget click action.
2. In Ocelin Settings, enable **Share counts and RAM with the taskbar text strip** and choose **Connect taskbar strip**. Saving the package for manual import remains available.
3. In Taskbar Widgets Settings, inspect the `Ocelin.twidget` permissions and approve it yourself. Enable **Ocelin sessions** and choose its position. With adapter 0.6.4, the patched host and the updated desktop, clicking anywhere on the widget opens the session panel at the right edge of the display. Reconnecting an installed version opens Settings; if the host offers a duplicate installation, cancel it and enable **Ocelin sessions** in the library.
4. Disable sharing in Ocelin or remove the widget in Taskbar Widgets to disconnect it.

Aggregate running/attention counts, app RAM and the Windows light/dark theme leave Ocelin's process through `%LOCALAPPDATA%\Ocelin\taskbar-summary.json`. The text follows the Windows taskbar theme independently of Ocelin's appearance. No network server, transcripts, project paths, account data or commands are exposed. The provider displays offline after 35 seconds without a fresh snapshot.

The pixel mascot uses the same approved artwork as Ocelin: typing for running work, waving for attention, idle when quiet and sleeping when disconnected. Native GIF playback avoids an extra browser process. Static PNGs are used when Ocelin or Windows requests reduced motion. Unchanged snapshots are held for up to 20 seconds so animation can continue smoothly.

Upstream 0.5.36 contains hardcoded Turkish permission-review text and can enable the wrong widget after a first installation with its runtime stopped. The [source patches](patches/README.md) preserve its approval flow, translate the review, wait for the correct widget before enabling it and add the native root action. The optional host build is reproducible.

The adapter uses a normal-user PowerShell process. The host requires a broad `system.fullAccess` declaration for process providers and cannot sandbox that grant. The provider reads the fixed summary file and bundled pet assets, writes JSON responses, and opens only the fixed `ocelin://panel` link on click. It accepts no commands or paths from widget data. Review its small source before granting that permission.

The user confirmed adapter 0.6.3's pet is visible alongside counts and RAM. Its physical asset paths fix the earlier MSIX file-virtualization failure; provider tests cover GIF/PNG resolution through a directory junction. The package self-test and all 694 core tests pass. The right-edge panel smoke check passes URI launch, closing, reopening, reduced motion and dismissal without a tray icon. Adapter 0.6.4 still awaits package approval and a live whole-widget click check. Native Windows App Tasks cards remain separately unverified.

Updating the host executable itself needs a fresh Windows shell: unload the host, replace its files, then sign out and back in before loading the new host. An earlier replacement caused one Explorer crash and automatic restart. The host containing the primary-action patch passed CI run 35214530612 and was installed after a controlled Explorer restart; no second crash has been observed so far. This is not a general stability guarantee. Updating only `Ocelin.twidget` keeps the existing host binary.

References: [Community SDK](https://github.com/pfcdev/TaskbarWidgets/tree/main/community-sdk), [process protocol](https://github.com/pfcdev/TaskbarWidgets/blob/main/community-sdk/process-runtime.md), [Windows widgets board](https://learn.microsoft.com/en-us/windows/apps/design/widgets/). Ocelin's adapter is original MIT-licensed code, not a bundled copy of the host.
