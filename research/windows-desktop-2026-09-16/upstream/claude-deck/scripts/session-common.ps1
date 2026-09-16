# ClaudeDeck - shared library (dot-sourced by the UI scripts).
#
# This is the single home for the small helpers that used to be copy-pasted across
# session-view.ps1, session-tray.ps1, session-stats.ps1 and session-update.ps1:
#   * the data-layout paths under ~/.claude/sessions  (Get-CDRoot / Get-CDPath)
#   * UTF-8 (no BOM) file writes                       (Get-CDUtf8 / Write-CDText)
#   * flag-file presence toggle                        (Toggle-Flag)
#   * per-project accent colour + initials badge       (Get-ProjectColor / Get-Initials / Get-TextOn)
#   * per-project objective task list normaliser        (ConvertTo-CDTasks)
#   * the self-updater bridge                          (Get-LocalVersion / Invoke-Updater / Get-UpdateInfo)
#
# DOT-SOURCE SAFETY (same rules as session-workspaces.ps1): this file is dot-sourced
# into a live WinForms scope, so it MUST stay side-effect free -
#   * no param() block,
#   * no $ErrorActionPreference at script scope (it would leak into the caller),
#   * top level defines functions + pure constants only - nothing that runs UI or IO.
# Every function guards itself with try/catch. The colour helpers return
# System.Drawing.Color, so the caller must have loaded System.Drawing before calling
# them (every consumer does); they are never invoked at dot-source time.
#
# NB: session-tracker.ps1 deliberately does NOT depend on this file. It runs inside
# Claude Code hooks and must never throw, so it stays fully self-contained.

# --- Data & settings layout ------------------------------------------------
# Every runtime file lives under ~/.claude/sessions. Resolve paths through these
# two helpers instead of re-typing the '.claude\sessions' literal everywhere, so
# the layout has a single source of truth.
function Get-CDRoot { Join-Path $env:USERPROFILE '.claude\sessions' }
function Get-CDPath([string]$relative) { Join-Path (Get-CDRoot) $relative }

# --- High-DPI awareness -----------------------------------------------------
# WinForms looks fuzzy on multi-monitor / mixed-scaling setups unless the process
# declares PER-MONITOR-V2 DPI awareness. The legacy SetProcessDPIAware() only pins
# rendering to the PRIMARY monitor's DPI, so any window shown on a differently-
# scaled monitor gets bitmap-stretched by Windows -> blurry text. Per-Monitor-V2
# makes WinForms render at each monitor's native DPI; our fonts are point-based and
# our window sizes derive from the active screen, so the layout follows correctly.
# Call ONCE per process, before any window is created. Walks the API chain newest
# -> oldest so it still does something on pre-1703 Windows. Never throws; the
# PER-MONITOR-V2 path does not need System.Windows.Forms loaded yet.
function Set-CDDpiAware {
  try {
    if (-not ('CDNative.Dpi' -as [type])) {
      Add-Type -Namespace CDNative -Name Dpi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
[System.Runtime.InteropServices.DllImport("shcore.dll")]
public static extern int SetProcessDpiAwareness(int value);
'@ -ErrorAction Stop
    }
    # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4 (Windows 10 1703+).
    if ([CDNative.Dpi]::SetProcessDpiAwarenessContext([System.IntPtr](-4))) { return }
    # PROCESS_PER_MONITOR_DPI_AWARE = 2 (Windows 8.1+); HRESULT S_OK = 0.
    if ([CDNative.Dpi]::SetProcessDpiAwareness(2) -eq 0) { return }
  } catch {}
  # Last resort: legacy system-DPI awareness (still better than unaware).
  try { [System.Windows.Forms.Application]::SetProcessDPIAware() | Out-Null } catch {}
}

# --- UTF-8 without BOM ------------------------------------------------------
# PS 5.1's Set-Content / Out-File mangle accents; always write through this.
$script:CDUtf8 = New-Object System.Text.UTF8Encoding($false)
function Get-CDUtf8 { return $script:CDUtf8 }
function Write-CDText([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, $script:CDUtf8)
}

# --- Cloud sync (optional) --------------------------------------------------
# ClaudeDeck can mirror the PORTABLE user data - the per-project todo list
# (objectives.json) and the activity history (events) - to a folder you keep in
# sync across machines (Google Drive / OneDrive / Synology Drive, ...). Only these
# two travel; live session state, flags, opacity/size and version stay machine-local.
#
# The target folder lives in sync.txt (a value file, like opacity.txt). When set
# and reachable:
#   * objectives.json  ->  <sync>\objectives.json          (one shared file)
#   * activity events  ->  <sync>\events-<HOST>.jsonl       (ONE file per machine,
#                          so two PCs never collide on an append; the stats view
#                          reads every events*.jsonl and merges them)
# If the folder is unset or temporarily missing (Drive not mounted yet), every
# helper transparently falls back to the local ~/.claude/sessions copy - nothing
# ever breaks. Events need no migration: the old local events.jsonl keeps being
# read (Get-CDEventLogs merges it in) and only NEW events go to the per-host file.

# The configured sync folder, or $null. Must exist on disk to count as reachable
# (so an unmounted drive / offline NAS silently falls back to local).
function Get-CDSyncDir {
  try {
    $f = Get-CDPath 'sync.txt'
    if (Test-Path $f) {
      $p = ([System.IO.File]::ReadAllText($f)).Trim()
      if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
  } catch {}
  return $null
}

# A filesystem-safe machine tag for the per-host event log (COMPUTERNAME, sanitised).
function Get-CDHostTag {
  $h = [string]$env:COMPUTERNAME
  if (-not $h) { $h = 'pc' }
  return ($h -replace '[^A-Za-z0-9_-]', '_')
}

# Where objectives.json lives: the sync folder if configured & reachable, else local.
function Get-CDObjectivesPath {
  $s = Get-CDSyncDir
  if ($s) { return (Join-Path $s 'objectives.json') }
  return (Get-CDPath 'objectives.json')
}

# Where THIS machine APPENDS activity events: a per-host file in the sync folder if
# configured, else the local single log. (Reading uses Get-CDEventLogs, which merges
# every file - the local legacy log plus one per machine.)
function Get-CDEventWritePath {
  $s = Get-CDSyncDir
  if ($s) { return (Join-Path $s ('events-{0}.jsonl' -f (Get-CDHostTag))) }
  return (Get-CDPath 'stats\events.jsonl')
}

# Every event log to READ: the local stats\events.jsonl (pre-sync / legacy history)
# plus every events*.jsonl in the sync folder (one per machine). De-duplicated by
# full path so a file is never counted twice.
function Get-CDEventLogs {
  $paths = New-Object System.Collections.Generic.List[string]
  $local = Get-CDPath 'stats\events.jsonl'
  if (Test-Path $local) { [void]$paths.Add($local) }
  $s = Get-CDSyncDir
  if ($s) {
    try {
      foreach ($f in Get-ChildItem -LiteralPath $s -Filter 'events*.jsonl' -File -ErrorAction SilentlyContinue) {
        if (-not $paths.Contains($f.FullName)) { [void]$paths.Add($f.FullName) }
      }
    } catch {}
  }
  return $paths
}

# Configure (or clear, when $path is empty) the cloud sync folder. On first set it
# seeds <sync>\objectives.json from the existing local todo list when the sync folder
# has none yet, so your current todos are never orphaned. Returns the trimmed path,
# or $null when cleared.
function Set-CDSyncDir([string]$path) {
  $f = Get-CDPath 'sync.txt'
  $p = ([string]$path).Trim()
  if (-not $p) { try { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } catch {}; return $null }
  try { if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null } } catch {}
  Write-CDText $f $p
  try {
    $dst = Join-Path $p 'objectives.json'
    $src = Get-CDPath 'objectives.json'
    if (-not (Test-Path -LiteralPath $dst) -and (Test-Path -LiteralPath $src)) {
      Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction SilentlyContinue
    }
  } catch {}
  return $p
}

# --- Flag files (presence = on) --------------------------------------------
# Toggle a flag file on/off. $path is the full flag path (callers already hold it).
function Toggle-Flag([string]$path) {
  if (Test-Path $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  else { Set-Content -LiteralPath $path -Value '' -Encoding ASCII -ErrorAction SilentlyContinue }
}

# --- ClaudeDeck brand accent ------------------------------------------------
# The single terracotta-orange that brands the deck: the collapsed strip, the
# "Claude Code Sessions" title and the focus-nudge Matrix rain all derive from
# this one value. Change it here and every surface follows. (Returns a Color, so
# the caller must have loaded System.Drawing - every consumer does.)
function Get-CDAccent { return [System.Drawing.Color]::FromArgb(204, 115, 81) }

# --- Per-project accent colour + initials badge ----------------------------
# Stable hash of the project name -> hue, so the same project always gets the same
# colour in both the deck and the stats dashboard.
function Hue2Rgb($p, $q, $t) {
  if ($t -lt 0) { $t += 1 }; if ($t -gt 1) { $t -= 1 }
  if ($t -lt (1.0/6)) { return $p + ($q - $p) * 6 * $t }
  if ($t -lt 0.5)     { return $q }
  if ($t -lt (2.0/3)) { return $p + ($q - $p) * ((2.0/3) - $t) * 6 }
  return $p
}
function Get-ProjectColor($name) {
  if (-not $name) { $name = '?' }
  $hsh = 0
  foreach ($c in $name.ToCharArray()) { $hsh = [int](($hsh * 31 + [int]$c) % 360) }
  $h = $hsh / 360.0; $s = 0.55; $l = 0.62
  $q = if ($l -lt 0.5) { $l * (1 + $s) } else { $l + $s - $l * $s }
  $p = 2 * $l - $q
  $r = Hue2Rgb $p $q ($h + 1.0/3); $g = Hue2Rgb $p $q $h; $b = Hue2Rgb $p $q ($h - 1.0/3)
  return [System.Drawing.Color]::FromArgb([int]($r * 255), [int]($g * 255), [int]($b * 255))
}
# Up to two letters for the badge: leading capitals (camel/Pascal), else the first
# two characters upper-cased.
function Get-Initials($name) {
  if (-not $name) { return '?' }
  $caps = ($name -creplace '[^A-Z0-9]', '')
  if ($caps.Length -ge 2) { return $caps.Substring(0, 2) }
  return ($name.Substring(0, [math]::Min(2, $name.Length))).ToUpper()
}
# Black or white text, whichever stays legible on the given background.
function Get-TextOn($color) {
  $lum = (0.299 * $color.R + 0.587 * $color.G + 0.114 * $color.B) / 255.0
  if ($lum -gt 0.58) { return [System.Drawing.Color]::FromArgb(25, 25, 30) } else { return [System.Drawing.Color]::White }
}

# --- Per-project objective tasks -------------------------------------------
# objectives.json stores, per project, EITHER a legacy single string OR the new
# task list ( [ { text, done, desc } ] ). Both the deck (the scrollable one-line
# todo header) and the weekly recap read it, so the normaliser lives here — single
# source of truth. Returns an array of [pscustomobject]@{ text; done; desc }; a
# legacy string becomes one undone task; blanks and malformed entries are dropped.
# `desc` is the optional rich-text note for the task, stored as RTF (empty string
# when none) — the deck's task editor reads/writes it; older files have no `desc`,
# so it defaults to '' and stays absent for tasks that never got a note.
# (ConvertFrom-Json unwraps a single-element array into a bare object, hence @().)
# NB: return $out WITHOUT a leading comma. `return ,$out` would survive the @(...)
# the callers wrap it in as a SINGLE nested element (@(,$out) -> Count 1, [0]=$out),
# so a 3-task list collapsed to one "task" whose .text was the whole array — the deck
# header then rendered all texts joined + struck. Plain `return $out` enumerates right.
function ConvertTo-CDTasks($value) {
  $out = @()
  if ($null -eq $value) { return $out }
  if ($value -is [string]) {
    $t = ([string]$value).Trim()
    if ($t) { $out += [pscustomobject]@{ text = $t; done = $false; desc = '' } }
    return $out
  }
  foreach ($it in @($value)) {
    if ($null -eq $it) { continue }
    if ($it -is [string]) {
      $t = ([string]$it).Trim()
      if ($t) { $out += [pscustomobject]@{ text = $t; done = $false; desc = '' } }
      continue
    }
    $txt = ''
    try { $txt = ([string]$it.text).Trim() } catch {}
    if (-not $txt) { continue }
    $dn = $false
    try { $dn = [bool]$it.done } catch {}
    $ds = ''
    try { if ($null -ne $it.desc) { $ds = [string]$it.desc } } catch {}
    $out += [pscustomobject]@{ text = $txt; done = $dn; desc = $ds }
  }
  return $out
}

# --- .env settings ----------------------------------------------------------
# User-editable settings live in ~/.claude/sessions/.env (seeded from .env.example
# by the installer). Currently only the weekly-recap Ollama config. Returns a
# hashtable of UPPER-CASE keys, pre-filled with defaults so callers never have to
# null-check. KEY=VALUE per line; blank lines and #comments ignored; surrounding
# single/double quotes stripped. Side-effect free (reads the file on each call).
function Get-CDEnv {
  $env = @{
    # Provider: 'ollama' (native /api/generate) or 'openai' (any OpenAI-compatible
    # /v1/chat/completions endpoint). The LLM_* keys are the generic config used by
    # both; the legacy OLLAMA_* keys are still honoured as fallbacks (so an existing
    # .env keeps working). Empty LLM_* default => "unset", falls back to OLLAMA_*.
    LLM_PROVIDER           = 'ollama'
    LLM_URL                = ''
    LLM_MODEL              = ''
    LLM_API_KEY            = ''
    LLM_ENABLED            = ''
    LLM_TIMEOUT            = ''
    OLLAMA_URL             = 'http://localhost:11434'
    OLLAMA_MODEL           = 'gemma4:latest'
    OLLAMA_ENABLED         = 'true'
    OLLAMA_TIMEOUT         = '60'
    RECAP_INCLUDE_OUTCOMES = 'true'
    RECAP_OUTCOME_CHARS    = '250'
  }
  try {
    $f = Get-CDPath '.env'
    if (Test-Path $f) {
      foreach ($line in [System.IO.File]::ReadAllLines($f)) {
        $t = ([string]$line).Trim()
        if (-not $t -or $t.StartsWith('#')) { continue }
        $eq = $t.IndexOf('=')
        if ($eq -lt 1) { continue }
        $k = $t.Substring(0, $eq).Trim().ToUpper()
        $v = $t.Substring($eq + 1).Trim().Trim('"').Trim("'")
        if ($k) { $env[$k] = $v }
      }
    }
  } catch {}
  return $env
}

# --- Self-updater bridge ----------------------------------------------------
# session-update.ps1 does the actual version compare / download; these helpers let
# the deck and the tray launch it and read its result (update.json) without each
# re-deriving the paths. (Legacy names kept so existing call sites are unchanged.)
function Get-LocalVersion {
  try { $v = Get-CDPath 'version.txt'; if (Test-Path $v) { return ([System.IO.File]::ReadAllText($v)).Trim() } } catch {}
  return $null
}
# Launch a version check / install in a hidden background process (never blocks the UI).
function Invoke-Updater([string]$mode) {
  $updScript = Get-CDPath 'session-update.ps1'
  if (-not (Test-Path $updScript)) { return }
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $updScript), $mode
  ) -ErrorAction SilentlyContinue
}
# The parsed update.json when a newer version is available, else $null.
function Get-UpdateInfo {
  try {
    $f = Get-CDPath 'update.json'
    if (Test-Path $f) {
      $j = [System.IO.File]::ReadAllText($f) | ConvertFrom-Json
      if ($j.available) { return $j }
    }
  } catch {}
  return $null
}
# The parsed update-result.json written by the -Bootstrap worker after an install
# attempt (ok / version / error), else $null. The caller deletes the file once it
# has surfaced the outcome (so it's shown exactly once). This is the feedback loop:
# clicking "Install" used to be a black box - now the restarted tray reports the result.
function Get-UpdateResult {
  try {
    $f = Get-CDPath 'update-result.json'
    if (Test-Path $f) { return ([System.IO.File]::ReadAllText($f) | ConvertFrom-Json) }
  } catch {}
  return $null
}
function Clear-UpdateResult {
  try { Remove-Item -LiteralPath (Get-CDPath 'update-result.json') -Force -ErrorAction SilentlyContinue } catch {}
}
