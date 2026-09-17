# Ocelin inside the Windows taskbar

This optional adapter targets Taskbar Widgets 0.5.4 or newer using its schema v4 native renderer. The host uses private Windows XAML integration and may stop working after Windows updates. It is independent of Ocelin's built-in tile above the taskbar.

Adapter 0.6.3 fixes pet asset paths and is versioned independently of the desktop's unreleased 0.6.2 draft. Upgrade an existing adapter through the host's normal package review; this does not require replacing the host executable.

1. Install [Taskbar Widgets](https://github.com/pfcdev/TaskbarWidgets) if you want its experimental Explorer integration.
2. In Ocelin Settings, enable **Share counts and RAM with the taskbar text strip** and choose **Connect taskbar strip**. Saving the package for manual import remains available.
3. In Taskbar Widgets Settings, inspect the `Ocelin.twidget` permissions and approve it yourself. Enable the **Ocelin sessions** widget and choose its position. Its icon button opens Ocelin. Reconnecting an installed version starts the host and opens Settings instead of offering a duplicate installation. If the host's duplicate installer says the version is already installed, cancel it and enable **Ocelin sessions** in the library.
4. Disable sharing in Ocelin or remove the widget in Taskbar Widgets to disconnect it.

Aggregate running/attention counts, app RAM and the Windows light/dark theme leave Ocelin's process through `%LOCALAPPDATA%\Ocelin\taskbar-summary.json`. The text follows the Windows taskbar theme independently of Ocelin's appearance. No network server, transcripts, project paths, account data or commands are exposed. The provider displays offline after 35 seconds without a fresh snapshot.

The pixel mascot uses the same approved artwork as Ocelin: typing for running work, waving for attention, idle when quiet and sleeping when disconnected. Native GIF playback avoids an extra browser process. Static PNGs are used when Ocelin or Windows requests reduced motion. Unchanged snapshots are held for up to 20 seconds so animation can continue smoothly.

Upstream 0.5.36 contains hardcoded Turkish permission-review text and can enable the wrong widget after a first installation with its runtime stopped. The [source patches](patches/README.md) preserve its approval flow, translate the review and wait for the correct widget before enabling it. The optional host build is reproducible.

The adapter uses a normal-user PowerShell process. The host requires a broad `system.fullAccess` declaration for process providers and cannot sandbox that grant. The provider reads the fixed summary file and bundled pet assets, writes JSON responses, and opens only the fixed `ocelin://dashboard` link on click. It accepts no commands or paths from widget data. Review its small source before granting that permission.

The user approved adapter 0.6.2 and confirmed counts and RAM inside the taskbar, but its pet was missing. MSIX file virtualization left the emitted logical asset path unreadable by Explorer: an independent WMI check found only the physical package-cache file. Adapter 0.6.3 publishes resolved physical paths. A probe using the real redirected assets produced a path visible through WMI, and all seven provider tests passed, including GIF/PNG resolution through a directory junction. The package self-test and all 693 core tests also passed. Its permission review is open; the 0.6.3 pet still awaits visual confirmation in Explorer. Native Windows App Tasks cards remain separately unverified.

Updating the host executable itself needs a fresh Windows shell: unload the host, replace its files, then sign out and back in before loading the new host. During testing, replacing a loaded host caused one Explorer crash and automatic restart; the host reattached afterward. Updating only `Ocelin.twidget` keeps the existing host binary.

References: [Community SDK](https://github.com/pfcdev/TaskbarWidgets/tree/main/community-sdk), [process protocol](https://github.com/pfcdev/TaskbarWidgets/blob/main/community-sdk/process-runtime.md), [Windows widgets board](https://learn.microsoft.com/en-us/windows/apps/design/widgets/). Ocelin's adapter is original MIT-licensed code, not a bundled copy of the host.
