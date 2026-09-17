param([Parameter(Mandatory=$true)][string]$SdkBin)
$ErrorActionPreference = 'Stop'
$nativeRoot = $PSScriptRoot
$outputRoot = Join-Path $nativeRoot '..\dist\native'
$packageRoot = Join-Path $outputRoot 'package'
New-Item -ItemType Directory -Force -Path (Join-Path $packageRoot 'Assets'), (Join-Path $packageRoot 'Public') | Out-Null
$runtime = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$facade = Get-ChildItem (Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL\System.Runtime') -Filter System.Runtime.dll -Recurse | Select-Object -First 1 -ExpandProperty FullName
& (Join-Path $runtime 'csc.exe') /nologo /target:winexe /platform:x64 ('/out:' + (Join-Path $packageRoot 'Ocelin.Taskbar.exe')) ('/r:' + (Join-Path $env:WINDIR 'System32\WinMetadata\Windows.UI.winmd')) ('/r:' + (Join-Path $env:WINDIR 'System32\WinMetadata\Windows.Foundation.winmd')) ('/r:' + (Join-Path $runtime 'System.Runtime.WindowsRuntime.dll')) ('/r:' + $facade) /r:System.Web.Extensions.dll /r:System.Core.dll (Join-Path $nativeRoot 'TaskbarHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native taskbar host compilation failed' }
Copy-Item -LiteralPath (Join-Path $nativeRoot 'AppxManifest.xml') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $nativeRoot '..\assets\ocelin.png') -Destination (Join-Path $packageRoot 'Assets\ocelin.png')
& (Join-Path $SdkBin 'makeappx.exe') pack /o /d $packageRoot /p (Join-Path $outputRoot 'Ocelin.AppTasks.Local.msix')
if ($LASTEXITCODE -ne 0) { throw 'Native taskbar package build failed' }
