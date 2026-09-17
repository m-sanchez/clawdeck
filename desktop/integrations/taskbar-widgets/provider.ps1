$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$summaryFile = Join-Path $env:LOCALAPPDATA 'Ocelin\taskbar-summary.json'
$instances = @()
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))
$pending = $reader.ReadLineAsync()
$lastSent = [DateTime]::MinValue
while ($true) {
  if ($pending.Wait(500)) {
    $line = $pending.Result
    if ($null -eq $line) { break }
    try {
      $request = $line | ConvertFrom-Json
      if ($request.type -eq 'shutdown') { break }
      if ($request.type -in @('initialize', 'instancesChanged')) { $instances = @($request.instances) }
    } catch {}
    $pending = $reader.ReadLineAsync()
  }
  if (([DateTime]::UtcNow - $lastSent).TotalSeconds -lt 2) { continue }
  $lastSent = [DateTime]::UtcNow
  $headline = 'Ocelin offline'
  $detail = 'Open Ocelin to connect'
  try {
    $file = Get-Item -LiteralPath $summaryFile
    if ($file.Length -le 4096) {
      $summary = Get-Content -LiteralPath $summaryFile -Raw | ConvertFrom-Json
      $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$summary.sampledAt
      if ($summary.status -eq 'disabled') { $detail = 'Enable sharing in Ocelin' }
      elseif ($summary.schemaVersion -eq 1 -and $summary.status -eq 'ready' -and $age -ge 0 -and $age -lt 35000) {
        $running = [Math]::Max(0, [Math]::Min(9999, [int]$summary.running))
        $attention = [Math]::Max(0, [Math]::Min(9999, [int]$summary.attention))
        $headline = "$running running"
        if ($attention -gt 0) { $headline += " | $attention need you" }
        $ram = if ($null -eq $summary.memoryBytes) { 'RAM unavailable' } elseif ($summary.memoryBytes -ge 1GB) { '{0:N1} GB RAM' -f ($summary.memoryBytes / 1GB) } else { '{0:N0} MB RAM' -f ($summary.memoryBytes / 1MB) }
        $detail = "Codex + Claude | $ram"
      }
    }
  } catch {}
  foreach ($instance in $instances) {
    if (-not $instance.instanceId) { continue }
    @{ type = 'snapshot'; instanceId = $instance.instanceId; data = @{ headline = $headline; detail = $detail } } | ConvertTo-Json -Depth 4 -Compress | ForEach-Object { [Console]::WriteLine($_) }
  }
}
