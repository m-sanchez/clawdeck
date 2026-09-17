# Native Windows taskbar tasks

This small .NET Framework host uses Microsoft's `Windows.UI.Shell.Tasks` API. It publishes Ocelin's aggregate status and up to twelve recent running/attention tasks. Clicking a card routes through Ocelin to the exact Codex or Claude conversation. The separate Taskbar Widgets adapter provides the optional persistent text strip.

Requirements: Windows 11 with App Tasks enabled by Microsoft, .NET Framework 4.8, and the registered Ocelin App Tasks package. `IsSupported()` is checked at runtime. The API remains marked experimental; OS availability and package registration are reported separately from a working connection.

## Build and test locally

Generate the normal desktop assets first with `node desktop/prepare.mjs`. Use a Windows SDK containing MakeAppx and a Windows build whose system metadata includes App Tasks:

```powershell
.\desktop\native\build.ps1 -SdkBin 'C:\path\to\WindowsSDK\bin\x64'
```

The output is `desktop/dist/native/Ocelin.AppTasks.Local.msix`. This is an unsigned local development identity, not a signed production installer. Install the executable package from an administrator PowerShell:

```powershell
Add-AppxPackage -Path 'C:\path\to\Ocelin.AppTasks.Local.msix' -AllowUnsigned
```

Then enable **Settings → Native Windows taskbar tasks** in installed Ocelin. A future signed distribution must use its own publisher identity and certificate instead of the development OID. No certificate is installed and no Windows security setting is changed by these scripts.

## Lifecycle and data

The bridge reads a bounded local JSON snapshot. It accepts only fixed Ocelin activation routes, never shell commands or transcript paths. Titles and status are sent to the Windows shell; full transcripts are not. The packaged helper's virtualized local data folder is resolved by package identity during activation.

It reconciles existing task IDs, removes obsolete tasks, and clears the display after a 45-second producer timeout. Disable the setting before removing the package. The bridge uses the installed default Ocelin profile; isolated smoke profiles cannot publish to the real user's taskbar.

```powershell
Get-AppxPackage -Name Ocelin.AppTasks.Local | Remove-AppxPackage
```

References: [AppTaskInfo](https://learn.microsoft.com/en-us/uwp/api/windows.ui.shell.tasks.apptaskinfo), [AppTaskContent](https://learn.microsoft.com/en-us/uwp/api/windows.ui.shell.tasks.apptaskcontent), [local unsigned package testing](https://learn.microsoft.com/en-us/windows/msix/package/unsigned-package).
