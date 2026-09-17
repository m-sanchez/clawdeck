$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$items = @([Console]::In.ReadToEnd() | ConvertFrom-Json)
if ($items.Count -gt 4096) { throw 'Too many processes' }
$stopped = 0
$skipped = 0
foreach ($item in $items) {
  $process = $null
  try {
    if ($item.pid -le 0 -or $item.pid -eq $PID -or $item.started -notmatch '^\d{17,19}$' -or $item.path -notmatch '^[A-Za-z]:[\\/]') { throw 'Invalid identity' }
    $process = [Diagnostics.Process]::GetProcessById([int]$item.pid)
    $null = $process.Handle
    if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$item.started -or $process.MainModule.FileName -ine [string]$item.path -or [IO.Path]::GetFileName($process.MainModule.FileName) -ine [string]$item.name -or $process.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { throw 'Process changed' }
    $process.Kill()
    $stopped++
  } catch { $skipped++ } finally { if ($process) { $process.Dispose() } }
}
@{ stopped = $stopped; skipped = $skipped } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
