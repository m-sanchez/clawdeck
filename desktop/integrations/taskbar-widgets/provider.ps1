$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class OcelinTaskbarAssets
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint capacity, uint flags);

    public static string Resolve(string path)
    {
        using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            int capacity = 512;
            while (true)
            {
                var buffer = new StringBuilder(capacity);
                uint length = GetFinalPathNameByHandleW(file.SafeFileHandle, buffer, (uint)capacity, 0);
                if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (length < capacity)
                {
                    string resolved = buffer.ToString();
                    if (resolved.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + resolved.Substring(8);
                    if (resolved.StartsWith(@"\\?\", StringComparison.Ordinal)) return resolved.Substring(4);
                    return resolved;
                }
                if (length >= 32768) throw new PathTooLongException("The physical asset path exceeds the Windows path limit.");
                capacity = (int)length + 1;
            }
        }
    }
}
'@
} catch { [Console]::Error.WriteLine('Ocelin pet resolver unavailable; using fallback assets.') }
$petPaths = @{}
$resolvedPetPaths = @{}
foreach ($assetPose in @('coding', 'attention', 'idle', 'sleeping')) {
  foreach ($assetExtension in @('gif', 'png')) {
    $assetKey = "$assetPose.$assetExtension"
    $assetPath = Join-Path $PSScriptRoot "assets\$assetKey"
    $petPaths[$assetKey] = $assetPath
    try {
      $petPaths[$assetKey] = [OcelinTaskbarAssets]::Resolve($assetPath)
      $resolvedPetPaths[$assetKey] = $true
    } catch { [Console]::Error.WriteLine("Ocelin pet path lookup failed for $assetKey; using fallback.") }
  }
  if (-not $resolvedPetPaths["$assetPose.gif"] -and (Test-Path -LiteralPath $petPaths["$assetPose.png"] -PathType Leaf)) {
    $petPaths["$assetPose.gif"] = $petPaths["$assetPose.png"]
  }
}
$summaryFile = Join-Path $env:LOCALAPPDATA 'Ocelin\taskbar-summary.json'
$instances = @()
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))
$pending = $reader.ReadLineAsync()
$lastSent = [DateTime]::MinValue
$theme = 'dark'
$lastSnapshots = @{}
while ($true) {
  if ($pending.Wait(500)) {
    $line = $pending.Result
    if ($null -eq $line) { break }
    try {
      $request = $line | ConvertFrom-Json
      if ($request.type -eq 'shutdown') { break }
      if ($request.type -in @('initialize', 'instancesChanged')) { $instances = @($request.instances); $lastSnapshots = @{} }
      if ($request.type -eq 'action' -and $request.action -eq 'openOcelin') { Start-Process -FilePath 'ocelin://dashboard' -WorkingDirectory $env:LOCALAPPDATA -WindowStyle Hidden }
    } catch {}
    $pending = $reader.ReadLineAsync()
  }
  if (([DateTime]::UtcNow - $lastSent).TotalSeconds -lt 2) { continue }
  $lastSent = [DateTime]::UtcNow
  $headline = 'Ocelin offline'
  $detail = 'Open Ocelin to connect'
  $pose = 'sleeping'
  $motion = $true
  try {
    $file = Get-Item -LiteralPath $summaryFile
    if ($file.Length -le 4096) {
      $summary = Get-Content -LiteralPath $summaryFile -Raw | ConvertFrom-Json
      if ($summary.theme -in @('light', 'dark')) { $theme = $summary.theme }
      $motion = $summary.motion -ne $false
      $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$summary.sampledAt
      if ($summary.status -eq 'disabled') { $detail = 'Enable sharing in Ocelin' }
      elseif ($summary.schemaVersion -eq 1 -and $summary.status -eq 'ready' -and $age -ge 0 -and $age -lt 35000) {
        $running = [Math]::Max(0, [Math]::Min(9999, [int]$summary.running))
        $attention = [Math]::Max(0, [Math]::Min(9999, [int]$summary.attention))
        $pose = if ($attention -gt 0) { 'attention' } elseif ($running -gt 0) { 'coding' } else { 'idle' }
        $headline = if ($running -gt 0) { "$running running" } else { 'All quiet' }
        if ($attention -gt 0) { $headline = if ($attention -eq 1) { '1 needs you' } else { "$attention need you" } }
        $ram = if ($null -eq $summary.memoryBytes) { 'RAM unavailable' } elseif ($summary.memoryBytes -ge 1GB) { '{0:N1} GB RAM' -f ($summary.memoryBytes / 1GB) } else { '{0:N0} MB RAM' -f ($summary.memoryBytes / 1MB) }
        $detail = if ($attention -gt 0 -and $running -gt 0) { "$running active | $($ram -replace ' RAM$', '')" } else { $ram }
      }
    }
  } catch {}
  $foreground = if ($theme -eq 'light') { '#FF202520' } else { '#FFF0EEE5' }
  $secondary = if ($theme -eq 'light') { '#FF47534A' } else { '#FFB9C6BB' }
  $accent = if ($theme -eq 'light') { '#FF85530B' } else { '#FFEDBD77' }
  $extension = if ($motion) { 'gif' } else { 'png' }
  $pet = $petPaths["$pose.$extension"]
  if (-not $pet) { $pet = Join-Path $PSScriptRoot "assets\$pose.$extension" }
  $data = [ordered]@{ headline = $headline; detail = $detail; foreground = $foreground; secondary = $secondary; accent = $accent; pet = $pet }
  $signature = $data | ConvertTo-Json -Compress
  foreach ($instance in $instances) {
    if (-not $instance.instanceId) { continue }
    $previous = $lastSnapshots[$instance.instanceId]
    if ($previous -and $previous.signature -eq $signature -and ([DateTime]::UtcNow - $previous.at).TotalSeconds -lt 20) { continue }
    @{ type = 'snapshot'; instanceId = $instance.instanceId; data = $data } | ConvertTo-Json -Depth 4 -Compress | ForEach-Object { [Console]::WriteLine($_) }
    $lastSnapshots[$instance.instanceId] = @{ signature = $signature; at = [DateTime]::UtcNow }
  }
}
