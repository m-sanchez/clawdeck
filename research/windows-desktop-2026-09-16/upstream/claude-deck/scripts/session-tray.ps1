# Claude Sessions - minimalist Windows tray launcher.
#
# The tray is intentionally tiny: its menu holds only the essentials - open the
# large view ("the desk") and quit. Everything else - the live session list AND
# every setting (Do-not-disturb, transparency, size, updates, statistics, the
# favorite-workspaces save/reopen) - lives in the desk's on-screen gear menu (see
# session-view.ps1), which is the single canonical control surface.
#
# The tray still earns its keep by: owning the global hotkey (Win+Alt+C) that opens
# the desk from anywhere, and running the background auto-update check that the desk
# then surfaces.

# Single-instance guard: if another tray process is already running, exit.
# (A named mutex proved unreliable here, so we scan for a sibling process.)
$dupes = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*session-tray.ps1*' })
if ($dupes.Count -gt 0) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Shared library + the Pomodoro engine / activity classifier (dot-sourced into this
# scope). session-common provides Get-CDPath / Get-CDUtf8 and the updater bridge
# (Invoke-Updater / Get-UpdateInfo); session-pomodoro owns the whole Pomodoro clock,
# the foreground-activity classifier (Get-PomoCategory, reused by the focus nudge),
# and starts its own 1s timer. Load common first - the Pomodoro file depends on it.
. (Join-Path $PSScriptRoot 'session-common.ps1')
. (Join-Path $PSScriptRoot 'session-pomodoro.ps1')

# Per-Monitor-V2 DPI awareness (common): keeps the tray's menus and dialogs crisp
# on multi-monitor / mixed-scaling setups. Must run before any window is created.
Set-CDDpiAware

# --- Background auto-update (off by default) -------------------------------
# When autoUpdFlag is present, the tray periodically asks session-update.ps1 to
# compare the installed version with the GitHub repo (writing update.json) and
# INSTALLS a found update by itself - no click needed; the deck restarts on its
# own. update-attempted.txt remembers the last auto-attempted version so a failed
# install is never retried in a loop: that version falls back to the manual
# "Install update" entry (tray + desk gear menu), which always stays available.
# The toggle itself lives in the desk.
$autoUpdFlag   = Join-Path $env:USERPROFILE '.claude\sessions\autoupdate.flag'
$updInfoFile   = Join-Path $env:USERPROFILE '.claude\sessions\update.json'
$autoApplyMark = Join-Path $env:USERPROFILE '.claude\sessions\update-attempted.txt'

# Invoke-Updater (launch the check/apply) and Get-UpdateInfo (read update.json) live
# in session-common.ps1, shared with the deck.

# Check only when enabled, and at most once an hour. The throttle window (55 min)
# sits just under the hourly timer so every tick actually re-checks - a freshly
# published release is then noticed within ~1h instead of being suppressed for 12h.
# Returns $true when a check was actually launched, so the timer can schedule a
# quick follow-up tick to pick up its (asynchronous) result instead of waiting 1h.
function Invoke-UpdateCheckThrottled {
  if (-not (Test-Path $autoUpdFlag)) { return $false }
  try {
    if (Test-Path $updInfoFile) {
      $j = [System.IO.File]::ReadAllText($updInfoFile) | ConvertFrom-Json
      if ($j.checked -and ((Get-Date) - [datetime]$j.checked).TotalMinutes -lt 55) { return $false }
    }
  } catch {}
  Invoke-Updater '-Check'
  return $true
}

# Auto-install: when the auto-update flag is on and update.json reports a newer
# version we haven't tried yet, launch -Apply without user interaction (the
# bootstrap worker stops the deck, installs, and restarts the tray). Each version
# is attempted at most ONCE (update-attempted.txt): if the install fails, the
# user keeps the manual "Install update" entry instead of an endless retry loop.
# Returns $true when an install was launched (the caller then skips the
# "update available" balloon - the install balloon replaces it).
function Invoke-AutoApply {
  if (-not (Test-Path $autoUpdFlag)) { return $false }
  $u = Get-UpdateInfo
  if (-not $u) { return $false }
  $ver = [string]$u.latest
  if (-not $ver) { return $false }
  try {
    if ((Test-Path $autoApplyMark) -and ((([System.IO.File]::ReadAllText($autoApplyMark)).Trim()) -eq $ver)) { return $false }
  } catch {}
  try { Write-CDText $autoApplyMark $ver } catch {}
  try {
    $notify.BalloonTipTitle = 'ClaudeDeck update'
    $notify.BalloonTipText  = ('Installing v{0} automatically - the deck will restart in a moment.' -f $ver)
    $notify.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
    $notify.ShowBalloonTip(6000)
  } catch {}
  Invoke-Updater '-Apply'
  return $true
}

# Pop a one-shot tray balloon the first time we see a given available version this
# session, so the user is told without having to open the desk's gear menu. The
# tray menu (Build-Menu) carries the actual "Install update" action.
$script:notifiedUpdVer = $null
function Show-UpdateNotice {
  $u = Get-UpdateInfo
  if (-not $u) { return }
  $ver = [string]$u.latest
  if ($ver -and $ver -ne $script:notifiedUpdVer) {
    $script:notifiedUpdVer = $ver
    try {
      $notify.BalloonTipTitle = 'ClaudeDeck update available'
      $notify.BalloonTipText  = ('Version {0} is ready. Open the deck (Win+Alt+C) or the tray menu to install.' -f $ver)
      $notify.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
      $notify.ShowBalloonTip(8000)
    } catch {}
  }
}

# After an install attempt the -Bootstrap worker leaves update-result.json and
# restarts us; surface its outcome as a balloon (then clear it so it shows once).
# This closes the loop the old design lacked: "Install" no longer fails silently.
function Show-UpdateResult {
  $r = Get-UpdateResult
  if (-not $r) { return }
  Clear-UpdateResult
  try {
    if ($r.ok) {
      $notify.BalloonTipTitle = 'ClaudeDeck updated'
      $notify.BalloonTipText  = ('Now running v{0}.' -f $r.version)
      $notify.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
    } else {
      $notify.BalloonTipTitle = 'ClaudeDeck update failed'
      $notify.BalloonTipText  = ('Could not install v{0} ({1}). Try again from the tray menu.' -f $r.version, $r.error)
      $notify.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Warning
    }
    $notify.ShowBalloonTip(8000)
  } catch {}
}

# App icon: prefer the bundled logo.ico (sits next to this script, both in the
# repo and once deployed to ~/.claude/sessions); fall back to a system icon.
function Get-AppIcon {
  $p = Join-Path $PSScriptRoot 'logo.ico'
  if (Test-Path $p) { try { return New-Object System.Drawing.Icon($p) } catch {} }
  return [System.Drawing.SystemIcons]::Information
}
$appIcon = Get-AppIcon

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $appIcon
$notify.Text = 'Claude Sessions'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$notify.ContextMenuStrip = $menu

# The whole tray menu: open the desk, and quit (plus a prominent install entry
# when an update is waiting). Nothing else by design.
function Build-Menu {
  $menu.Items.Clear()

  # Shown only when update.json reports a newer version - mirrors the desk's gear menu.
  $upd = Get-UpdateInfo
  if ($upd) {
    $ui = $menu.Items.Add(("Install update (v{0})" -f $upd.latest))
    $ui.ForeColor = [System.Drawing.Color]::FromArgb(80, 160, 90)
    $ui.ToolTipText = "Downloads the latest GitHub release and installs it; the deck restarts automatically"
    $ui.Add_Click({
      try {
        $notify.BalloonTipTitle = 'ClaudeDeck update'
        $notify.BalloonTipText  = 'Downloading and installing - the deck will restart automatically.'
        $notify.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
        $notify.ShowBalloonTip(6000)
      } catch {}
      Invoke-Updater '-Apply'
    })
    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  }

  $big = $menu.Items.Add('Show large view')
  $big.ToolTipText = "Open the deck - sessions and all settings live there (also Win+Alt+C)"
  $big.Add_Click({
    $vbs = Join-Path $env:USERPROFILE '.claude\sessions\show-view.vbs'
    Start-Process wscript.exe -ArgumentList ('"{0}"' -f $vbs) -ErrorAction SilentlyContinue
  })

  $rec = $menu.Items.Add('Weekly recap')
  $rec.ToolTipText = "Summarize this week's work per project (auto-opens every Friday at 17:00)"
  $rec.Add_Click({
    $vbs = Join-Path $env:USERPROFILE '.claude\sessions\show-recap.vbs'
    Start-Process wscript.exe -ArgumentList ('"{0}"' -f $vbs) -ErrorAction SilentlyContinue
  })

  $setup = $menu.Items.Add('Setup / configuration...')
  $setup.ToolTipText = "Open the setup panel (recap LLM, cloud sync folder, updates, focus)"
  $setup.Add_Click({
    $vbs = Join-Path $env:USERPROFILE '.claude\sessions\show-onboarding.vbs'
    Start-Process wscript.exe -ArgumentList ('"{0}"' -f $vbs) -ErrorAction SilentlyContinue
  })

  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $quit = $menu.Items.Add('Quit')
  $quit.ToolTipText = "Stop ClaudeDeck entirely (tray + desk)"
  $quit.Add_Click({ $notify.Visible = $false; [System.Windows.Forms.Application]::Exit() })
}

# Background update check: an initial check shortly after start, then hourly.
# When a check is launched (async child process), the next tick comes after 90s
# instead of 1h so a freshly found update is auto-installed right away.
$updTimer = New-Object System.Windows.Forms.Timer
$updTimer.Interval = 8000   # first tick ~8s after launch, then switches to hourly
$updTimer.Add_Tick({
  $updTimer.Interval = 3600000
  Show-UpdateResult                                  # if we were just restarted by an install, report its outcome (once)
  if (-not (Invoke-AutoApply)) { Show-UpdateNotice } # auto-install a known update, or just surface it (balloon)
  if (Invoke-UpdateCheckThrottled) { $updTimer.Interval = 90000 }  # quick follow-up tick to consume the fresh result
})
$updTimer.Start()

$menu.Add_Opening({ Build-Menu })

# Left-click also opens the menu (NotifyIcon shows it on right-click by default)
$notify.Add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $m = $notify.GetType().GetMethod('ShowContextMenu', [System.Reflection.BindingFlags]'NonPublic,Instance')
    $m.Invoke($notify, $null)
  }
})

# --- Global hotkey: open/focus the large view from anywhere ---------------
# Default Win+Alt+C (the Win key alone is mostly reserved by Windows; Win+Alt+
# <key> is registrable). Edit $HotMods / $HotVk below to change.
#   modifiers: ALT=1, CTRL=2, SHIFT=4, WIN=8 (combine with -bor); NOREPEAT=0x4000
#   key (VK):  'C'=0x43  'S'=0x53  'D'=0x44  'J'=0x4A  F8=0x77  F9=0x78
$HotMods = (1 -bor 8 -bor 0x4000)   # Win + Alt (+ no-repeat)
$HotVk   = 0x43                     # C

Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class HotKeyWindow : NativeWindow {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint m, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  const int WM_HOTKEY = 0x0312;
  public event Action Pressed;
  int _id = 0;
  public HotKeyWindow() { CreateHandle(new CreateParams()); }
  public bool Register(uint mods, uint vk) { return RegisterHotKey(this.Handle, ++_id, mods, vk); }
  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_HOTKEY && Pressed != null) Pressed();
    base.WndProc(ref m);
  }
}
"@

# --- Pomodoro engine + focus classifier ------------------------------------
# The whole Pomodoro clock and the foreground-activity classifier now live in
# session-pomodoro.ps1 (dot-sourced at the top). It runs its own 1s timer and
# publishes pomodoro.json; it also exposes Get-PomoCategory + Play-PomoChime,
# which the focus nudge below reuses.

# ============================================================================
# Focus nudge
# When NO Claude session is active and you've drifted onto a distracting app,
# Claude - who is bored and rather keen on your projects - pokes you with the
# gentle chime and a flash of the deck (stamped via focus-nudge.txt, which the
# deck watches). It KEEPS nudging the whole time you stay off-track and only
# stops once you refocus a real app (VS Code, Unity, a Windows Explorer window -
# anything that isn't a known distraction). ON by default; opt out via
# focus-off.flag (toggled from the deck's gear menu), silenced by Do-Not-Disturb.
# Reuses the Pomodoro engine's foreground classifier.
# ============================================================================
$focusOffFlag   = Join-Path $env:USERPROFILE '.claude\sessions\focus-off.flag'    # presence = nudge DISABLED. The focus nudge is ON by default, so we gate on an opt-OUT marker (toggled from the deck's gear menu).
$dndFlag        = Join-Path $env:USERPROFILE '.claude\sessions\dnd.flag'
$stateDir       = Join-Path $env:USERPROFILE '.claude\sessions\state'
$nudgeSignal    = Join-Path $env:USERPROFILE '.claude\sessions\focus-nudge.txt'  # re-stamped with [Environment]::TickCount on EVERY tick while you're on a distraction; the deck holds the Matrix up while the stamp stays fresh and fades it once you refocus a real app
$CHIME_GAP_MS   = 60000    # audible re-nag at most once per minute (the visual nag is continuous until you refocus)
$WAITING_WIN_SEC = 30      # a 'waiting' session counts as active only if touched within 30s (a stale 'waiting' must not suppress the nudge forever)
$RUNNING_WIN_SEC = 21600   # a 'running' session counts as active for up to 6h - the tracker only stamps 'updated' at prompt time, so a long turn keeps no fresh stamp; we trust the running status for the whole turn and let the 6h cap release a crashed/zombie session
$script:lastChime = 0      # [Environment]::TickCount of the last chime (0 = never)

# A session is "active" (so Claude is NOT bored) when any state file is running or
# waiting. While Claude is WORKING ('running') we don't nudge at all for the whole
# turn - the tracker only refreshes 'updated' at the start of the turn, so the 30s
# staleness window would wrongly expire a long running turn and let the nudge fire
# while Claude is busy. We give 'running' a generous 6h window (zombie backstop) and
# keep the short 30s window only for 'waiting'.
function Any-SessionActive {
  if (-not (Test-Path $stateDir)) { return $false }
  $now = Get-Date
  foreach ($f in Get-ChildItem $stateDir -Filter *.json -ErrorAction SilentlyContinue) {
    try {
      $o = [System.IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json
      $upd = $f.LastWriteTime
      try { $upd = [datetime]$o.updated } catch {}
      $age = ($now - $upd).TotalSeconds
      if ($o.status -eq 'running' -and $age -le $RUNNING_WIN_SEC) { return $true }
      if ($o.status -eq 'waiting' -and $age -le $WAITING_WIN_SEC) { return $true }
    } catch {}
  }
  return $false
}

# Every 5s: while enabled (default on), not DND, no active session, and you're on a
# known distraction -> RE-STAMP the signal file on every tick. The deck holds its
# Matrix overlay up the whole time the stamp stays fresh, so the visual nag is
# continuous; it fades the moment you refocus a real app (the stamps stop). The
# chime + reopening a closed deck are throttled to once a minute so it nags without
# becoming a strobe. The 5s cadence keeps the deck's freshness check current.
$focusTimer = New-Object System.Windows.Forms.Timer
$focusTimer.Interval = 5000
$focusTimer.Add_Tick({
  if (Test-Path $focusOffFlag) { return }   # nudge disabled (it's on by default)
  if (Test-Path $dndFlag) { return }
  if (Any-SessionActive) { return }
  $info = Get-PomoCategory
  if ($info.cat -ne 'distract') { return }  # refocusing VS Code / Unity / Explorer (or any non-distraction) lets the stamp go stale -> the deck fades the nudge
  $now = [Environment]::TickCount
  try { Set-Content -LiteralPath $nudgeSignal -Value $now -Encoding ASCII -ErrorAction SilentlyContinue } catch {}
  # Audible re-nag + reopen a closed deck, at most once a minute (the visual is continuous).
  if (($now - $script:lastChime) -lt $CHIME_GAP_MS) { return }
  $script:lastChime = $now
  Play-PomoChime
  try {
    $deckOpen = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*session-view.ps1*' }).Count -gt 0
    if (-not $deckOpen) {
      $vbs = Join-Path $env:USERPROFILE '.claude\sessions\show-view.vbs'
      Start-Process wscript.exe -ArgumentList ('"{0}"' -f $vbs) -ErrorAction SilentlyContinue
    }
  } catch {}
})
$focusTimer.Start()

# ============================================================================
# Distraction time tracker
# Independently of the nudge (and of whether a session is running), sample the
# foreground every 15s and bank any time spent on a known distraction. The tally
# is flushed to events.jsonl as a 'distract' event (project 'distraction') when
# you leave the distraction, or at least every 5 min for a long stint - so the
# stats dashboard can show a "distraction" project = time spent off task. Shares
# the nudge's on/off switch (focus-off.flag). Reuses the Pomodoro classifier.
# Best-effort; a logging failure is swallowed.
# ============================================================================
# Event log path is resolved per-flush via Get-CDEventWritePath (it follows the
# cloud-sync folder, which can be set after the tray started).
$cdUtf8             = Get-CDUtf8
$DISTRACT_SAMPLE_MS = 15000
$DISTRACT_FLUSH_MS  = 300000   # flush an ongoing stint at least every 5 min (cap loss on crash)
$script:distractAcc       = 0                          # seconds banked since the last flush
$script:distractFlushTick = [Environment]::TickCount

function Flush-Distract {
  if ($script:distractAcc -le 0) { return }
  try {
    $line = ([ordered]@{
      ts = (Get-Date).ToString('o'); ev = 'distract'; id = 'focus'
      project = 'distraction'; ctx = $null; sec = [int]$script:distractAcc
    } | ConvertTo-Json -Compress)
    $log = Get-CDEventWritePath
    $dir = Split-Path -Parent $log
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    for ($i = 0; $i -lt 5; $i++) {
      try { [System.IO.File]::AppendAllText($log, $line + "`r`n", $cdUtf8); break }
      catch { Start-Sleep -Milliseconds 40 }
    }
  } catch {}
  $script:distractAcc = 0
  $script:distractFlushTick = [Environment]::TickCount
}

$distractTimer = New-Object System.Windows.Forms.Timer
$distractTimer.Interval = $DISTRACT_SAMPLE_MS
$distractTimer.Add_Tick({
  if (Test-Path $focusOffFlag) { Flush-Distract; return }   # feature off -> bank what we have, stop tracking
  $cat = 'neutral'
  try { $cat = (Get-PomoCategory).cat } catch {}
  if ($cat -eq 'distract') {
    $script:distractAcc += [int]($DISTRACT_SAMPLE_MS / 1000)
    if (([Environment]::TickCount - $script:distractFlushTick) -ge $DISTRACT_FLUSH_MS) { Flush-Distract }
  } else {
    Flush-Distract   # back on task (or idle) -> bank the stint
  }
})
$distractTimer.Start()

# ============================================================================
# Weekly recap trigger
# Every Friday at 17:00, auto-open the weekly recap popup (session-recap.ps1) -
# once per week. recap-shown.txt holds the Monday-date tag of the week we last
# popped, so a tray restart (or the 30s tick landing after 17:00) never re-shows
# it. If the PC was off at 17:00 sharp, it fires at the first tick on/after 17:00
# that Friday instead - the report still shows the same day. Openable any time
# from the tray menu ("Weekly recap").
# ============================================================================
$recapShownFile = Join-Path $env:USERPROFILE '.claude\sessions\recap-shown.txt'
function Get-WeekTag([datetime]$d) {
  # Monday of $d's week, as yyyy-MM-dd - a stable per-week identifier.
  return $d.Date.AddDays(-((([int]$d.DayOfWeek) + 6) % 7)).ToString('yyyy-MM-dd')
}
$recapTimer = New-Object System.Windows.Forms.Timer
$recapTimer.Interval = 30000
$recapTimer.Add_Tick({
  $n = Get-Date
  if ($n.DayOfWeek -ne [System.DayOfWeek]::Friday) { return }
  if ($n.TimeOfDay -lt [timespan]'17:00:00') { return }
  $tag = Get-WeekTag $n
  $shown = ''
  try { if (Test-Path $recapShownFile) { $shown = ([System.IO.File]::ReadAllText($recapShownFile)).Trim() } } catch {}
  if ($shown -eq $tag) { return }
  try { [System.IO.File]::WriteAllText($recapShownFile, $tag, (New-Object System.Text.UTF8Encoding($false))) } catch {}
  $vbs = Join-Path $env:USERPROFILE '.claude\sessions\show-recap.vbs'
  Start-Process wscript.exe -ArgumentList ('"{0}"' -f $vbs) -ErrorAction SilentlyContinue
})
$recapTimer.Start()

$hk = New-Object HotKeyWindow
$hk.add_Pressed({
  $vbs = Join-Path $env:USERPROFILE '.claude\sessions\show-view.vbs'
  Start-Process wscript.exe -ArgumentList ('"{0}"' -f $vbs) -ErrorAction SilentlyContinue
})
# Try the chosen combo; fall back to a couple of alternatives if it's taken.
foreach ($try in @(
    @{ m = $HotMods;               v = $HotVk },
    @{ m = (1 -bor 8 -bor 0x4000); v = 0x4A },   # Win+Alt+J
    @{ m = (2 -bor 1 -bor 0x4000); v = 0x43 })) {  # Ctrl+Alt+C
  if ($hk.Register([uint32]$try.m, [uint32]$try.v)) { break }
}

# --- First-run setup panel -------------------------------------------------
# On the very first tray launch (no onboarding-done.flag yet) open the setup
# panel once, so a new user is walked through the recap LLM / cloud sync / update
# / focus settings. The panel writes the flag whether the user saves OR skips, so
# it never re-nags; it stays reachable from the tray menu and the deck's gear menu.
$onbFlag = Join-Path $env:USERPROFILE '.claude\sessions\onboarding-done.flag'
if (-not (Test-Path $onbFlag)) {
  $onbVbs = Join-Path $env:USERPROFILE '.claude\sessions\show-onboarding.vbs'
  if (Test-Path $onbVbs) { Start-Process wscript.exe -ArgumentList ('"{0}"' -f $onbVbs) -ErrorAction SilentlyContinue }
}

[System.Windows.Forms.Application]::Run()
