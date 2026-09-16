# Claude Code session tracker — called by hooks.
# Writes one JSON state file per session under .claude\sessions\state\
# Never throws into Claude Code: any failure -> silent exit 0.
param([ValidateSet('prompt','stop','end','notify')][string]$Event = 'prompt')

$ErrorActionPreference = 'SilentlyContinue'

# Read the hook payload (JSON) from stdin. Claude Code always sends UTF-8, but it
# reaches us by one of two paths and which one wins is a timing race:
#   1) the raw process stdin stream (OpenStandardInput) — pure bytes, we decode UTF-8;
#   2) PowerShell's $input pipeline — the host decodes the bytes for us, using
#      [Console]::InputEncoding. Its default is an OEM/ANSI code page, which mangles
#      accents (UTF-8 "à" -> "Ã "). Forcing UTF-8 here, before $input is enumerated,
#      makes that fallback decode correctly too.
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$raw = $null
try {
  $stdin = [Console]::OpenStandardInput()
  $ms = New-Object System.IO.MemoryStream
  $stdin.CopyTo($ms)
  if ($ms.Length -gt 0) { $raw = [System.Text.Encoding]::UTF8.GetString($ms.ToArray()) }
} catch {}
if (-not $raw) { $raw = (@($input) -join "`n") }
$raw = ([string]$raw).TrimStart([char]0xFEFF).Trim()   # drop a leading BOM, then whitespace
if (-not $raw) { exit 0 }
try { $data = $raw | ConvertFrom-Json } catch { exit 0 }

$id = $data.session_id
if (-not $id) { exit 0 }

$dir = Join-Path $env:USERPROFILE '.claude\sessions\state'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$file = Join-Path $dir ("{0}.json" -f $id)

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Save($obj) { [System.IO.File]::WriteAllText($file, ($obj | ConvertTo-Json -Depth 5), $utf8NoBom) }

# Append one event line to the stats log (stats\events.jsonl) — the historical
# record the statistics view reads. The per-session state file above is always
# overwritten, so this append-only log is what makes trends/durations possible.
# One compact JSON object per line: { ts, ev, id, project, ctx }. Best-effort and
# never fatal: a few short retries handle the rare cross-session write collision,
# then we give up silently (a missing event must never break Claude Code).
$statsDir = Join-Path $env:USERPROFILE '.claude\sessions\stats'
# Resolve where to append events. If a cloud-sync folder is configured (sync.txt)
# and reachable, write a PER-MACHINE log there (events-<HOST>.jsonl) so two PCs never
# collide on an append; otherwise the local stats\events.jsonl. Fully self-contained
# and best-effort - the tracker must never depend on session-common.ps1 (it runs
# inside Claude Code hooks and must never throw). Mirrors Get-CDEventWritePath there.
function Get-EventLogPath {
  try {
    $syncFile = Join-Path $env:USERPROFILE '.claude\sessions\sync.txt'
    if (Test-Path $syncFile) {
      $dir = ([System.IO.File]::ReadAllText($syncFile)).Trim()
      if ($dir -and (Test-Path -LiteralPath $dir)) {
        $hostTag = [string]$env:COMPUTERNAME
        if (-not $hostTag) { $hostTag = 'pc' }
        $hostTag = ($hostTag -replace '[^A-Za-z0-9_-]', '_')
        return (Join-Path $dir ('events-{0}.jsonl' -f $hostTag))
      }
    }
  } catch {}
  return (Join-Path $statsDir 'events.jsonl')
}
function Add-Event($ev, $proj, $ctx) {
  try {
    $line = ([ordered]@{
      ts      = (Get-Date).ToString('o')
      ev      = $ev
      id      = $id
      project = $proj
      ctx     = $ctx
    } | ConvertTo-Json -Compress)
    $log = Get-EventLogPath
    $logDir = Split-Path -Parent $log
    if ($logDir -and -not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    for ($i = 0; $i -lt 5; $i++) {
      try { [System.IO.File]::AppendAllText($log, $line + "`r`n", $utf8NoBom); break }
      catch { Start-Sleep -Milliseconds 40 }
    }
  } catch {}
}

# Context occupied: read the last assistant message's token usage from the
# session transcript (.jsonl). tokens = input + cache_creation + cache_read of
# the most recent message = how full the context window currently is.
# We report raw tokens only — no %, since the model's true context window size
# isn't reliably known (it varies by model and can't be trusted from the id).
function Get-ContextInfo($transcriptPath) {
  $res = @{ tokens = $null }
  try {
    if (-not $transcriptPath -or -not (Test-Path $transcriptPath)) { return $res }
    $lines  = Get-Content -LiteralPath $transcriptPath -Tail 120 -ErrorAction Stop
    $tokens = $null
    foreach ($ln in $lines) {
      if (-not $ln) { continue }
      try { $o = $ln | ConvertFrom-Json } catch { continue }
      $u = $o.message.usage
      if ($u -and ($null -ne $u.input_tokens)) {
        $t = [int]$u.input_tokens
        if ($null -ne $u.cache_creation_input_tokens) { $t += [int]$u.cache_creation_input_tokens }
        if ($null -ne $u.cache_read_input_tokens)     { $t += [int]$u.cache_read_input_tokens }
        $tokens = $t
      }
    }
    if ($null -ne $tokens) { $res.tokens = $tokens }
  } catch {}
  return $res
}
# Store context tokens onto an existing state object (idempotent add-or-set).
function Set-Ctx($o, $ctx) {
  foreach ($pair in @(@('ctx_tokens', $ctx.tokens))) {
    if ($o.PSObject.Properties.Name -contains $pair[0]) { $o.($pair[0]) = $pair[1] }
    else { $o | Add-Member -NotePropertyName $pair[0] -NotePropertyValue $pair[1] }
  }
}

# Discreet audible cue — replaces Claude Code's native notif sound, which the
# installer turns off ("preferredNotifChannel":"notifications_disabled"). Played
# when a session finishes a turn (stop) or needs the user (notify). Silenced under
# Do-Not-Disturb; any failure stays silent. notify.wav sits next to this script
# (deployed sessions dir, or scripts/ in the repo).
function Play-Chime {
  # $Repeat lets the work-done cue (stop) play twice back-to-back so it's
  # distinct from the single-chime focus nudge and the needs-you (notify) cue.
  param([int]$Repeat = 1)
  if (Test-Path (Join-Path $env:USERPROFILE '.claude\sessions\dnd.flag')) { return }
  $wav = Join-Path $PSScriptRoot 'notify.wav'
  if (Test-Path $wav) {
    $player = New-Object System.Media.SoundPlayer $wav
    for ($i = 0; $i -lt $Repeat; $i++) { $player.PlaySync() }   # PlaySync = sequential, so the two cues don't overlap
  }
}

switch ($Event) {
  'prompt' {
    $cwd = [string]$data.cwd
    $proj = if ($cwd) { Split-Path $cwd -Leaf } else { 'session' }
    # The prompt payload often carries IDE/harness-injected context blocks
    # (an opened file, a selection, a system reminder). When one of these comes
    # first, the label would show the file path instead of the real request, so
    # strip these wrapper blocks before deriving the label. (?s) = dot matches
    # newlines, so multi-line blocks are removed whole.
    $prompt = [string]$data.prompt
    $prompt = $prompt -replace '(?s)<ide_opened_file>.*?</ide_opened_file>', ''
    $prompt = $prompt -replace '(?s)<ide_selection>.*?</ide_selection>', ''
    $prompt = $prompt -replace '(?s)<system-reminder>.*?</system-reminder>', ''
    $prompt = ($prompt -replace '\s+', ' ').Trim()
    # If the turn carried only injected context (nothing typed), keep the prior
    # label rather than blanking it.
    if (-not $prompt -and (Test-Path $file)) {
      try { $prompt = [string]([System.IO.File]::ReadAllText($file) | ConvertFrom-Json).last_prompt } catch {}
    }
    $ctx = Get-ContextInfo ([string]$data.transcript_path)
    Save ([ordered]@{
      session_id  = $id
      cwd         = $cwd
      project     = $proj
      last_prompt = $prompt
      status      = 'running'
      updated     = (Get-Date).ToString('o')
      ctx_tokens  = $ctx.tokens
    })
    Add-Event 'prompt' $proj $ctx.tokens
  }
  'stop' {
    if (Test-Path $file) {
      $o = [System.IO.File]::ReadAllText($file) | ConvertFrom-Json
      $o.status  = 'done'
      $o.updated = (Get-Date).ToString('o')
      if ($o.PSObject.Properties.Name -contains 'seen') { $o.seen = $false }   # new completion = unseen
      Set-Ctx $o (Get-ContextInfo ([string]$data.transcript_path))            # refresh context at end of turn
      Save $o
      Add-Event 'stop' ([string]$o.project) $o.ctx_tokens
    } else {
      $cwd = [string]$data.cwd
      $ctx = Get-ContextInfo ([string]$data.transcript_path)
      $proj = if ($cwd) { Split-Path $cwd -Leaf } else { 'session' }
      Save ([ordered]@{
        session_id  = $id
        cwd         = $cwd
        project     = $proj
        last_prompt = ''
        status      = 'done'
        updated     = (Get-Date).ToString('o')
        ctx_tokens  = $ctx.tokens
      })
      Add-Event 'stop' $proj $ctx.tokens
    }
    Play-Chime -Repeat 2   # session finished a turn -> double chime (vs. single for nudge/needs-you)
  }
  'notify' {
    # Claude needs the user (permission request, question, etc.).
    # Scoped by the hook matcher; we also ignore the noisy idle notification.
    if (Test-Path $file) {
      $msg = ([string]$data.message -replace '\s+', ' ').Trim()
      # Only treat genuine "needs you" notifications (permission/approval) as waiting,
      # never the noisy idle prompt or auth notifications.
      if ($msg -match '(?i)permission|approv|confirm|allow|grant') {
        $o = [System.IO.File]::ReadAllText($file) | ConvertFrom-Json
        $o.status  = 'waiting'
        $o.updated = (Get-Date).ToString('o')
        if ($o.PSObject.Properties.Name -contains 'waiting_msg') { $o.waiting_msg = $msg }
        else { $o | Add-Member -NotePropertyName waiting_msg -NotePropertyValue $msg }
        Save $o
        Add-Event 'notify' ([string]$o.project) $null
        Play-Chime   # session needs the user (permission/approval)
      }
    }
  }
  'end' { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
}
exit 0
