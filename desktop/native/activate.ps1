param([string]$Arguments = '')
$ErrorActionPreference = 'Stop'
$package = Get-AppxPackage -Name 'Ocelin.AppTasks.Local' | Select-Object -First 1
if (!$package) { throw 'The Ocelin Windows App Tasks package is not installed.' }
$bridgeDir = Join-Path $env:LOCALAPPDATA ('Packages\' + $package.PackageFamilyName + '\LocalCache\Local\Ocelin')
New-Item -ItemType Directory -Path $bridgeDir -Force | Out-Null
$source = Join-Path $env:LOCALAPPDATA 'Ocelin\native-tasks.json'
if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $bridgeDir 'native-tasks.json') -Force }
Add-Type @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
    int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string app, [MarshalAs(UnmanagedType.LPWStr)] string args, int options, out uint pid);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}
public class OcelinActivation {
    public static uint Start(string app, string args) {
        uint pid;
        int result = ((IApplicationActivationManager)new ApplicationActivationManager()).ActivateApplication(app, args, 0, out pid);
        Marshal.ThrowExceptionForHR(result);
        return pid;
    }
}
'@
$bridgePid = [OcelinActivation]::Start(($package.PackageFamilyName + '!Taskbar'), $Arguments)
@{ pid = $bridgePid; directory = $bridgeDir } | ConvertTo-Json -Compress
