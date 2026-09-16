# Claude Sessions — large centered overlay (4K-friendly).
# Big dark always-on-top window listing sessions. Click a row to focus its
# VS Code / Cursor window. Auto-refreshes. Press Esc (or click ✕) to close.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Shared library + deck-specific partials (dot-sourced into this scope). Order
# matters: load the WinForms/Drawing assemblies above first, then session-common
# (paths + colour/updater helpers), then the interop types ([WinFocus]/[VDesk]/
# [NoActivateForm]), the icon renderer (uses common's colour helpers), and the
# repo/terminal helpers. See each file's header for what it owns.
. (Join-Path $PSScriptRoot 'session-common.ps1')
. (Join-Path $PSScriptRoot 'session-ui-interop.ps1')
. (Join-Path $PSScriptRoot 'session-ui-icons.ps1')
. (Join-Path $PSScriptRoot 'session-ui-repo.ps1')

# Declare Per-Monitor-V2 DPI awareness before any window is built (see common's
# Set-CDDpiAware): keeps the overlay crisp on multi-monitor / mixed-scaling setups.
Set-CDDpiAware

$WindowTitle = 'Claude Code Sessions'

# Single-instance via a named mutex. Exactly one view is alive at a time: if we
# can't create the mutex, another view already owns it -> pull its window onto THIS
# desktop (so it never yanks you elsewhere), surface it WITHOUT stealing keyboard
# focus (re-pop on task completion must never interrupt typing), and exit. The mutex is
# released the instant this view closes (see FormClosed), so a task finishing right
# after you close the view still pops a fresh one. The old process-scan guard could
# mistake a just-closed (still-dying) process for a live instance and silently
# swallow that popup — which is why the view didn't always appear.
$mutexCreated = $false
$script:viewMutex = New-Object System.Threading.Mutex($true, 'Local\ClaudeDeckView', [ref]$mutexCreated)
if (-not $mutexCreated) {
  $existing = [WinFocus]::FindExact($WindowTitle)
  if ($existing -ne [System.IntPtr]::Zero) {
    [VDesk]::FollowToCurrentDesktop($existing)
    [WinFocus]::SurfaceWindow($existing)   # surface without stealing focus - never interrupt typing
  }
  exit 0
}

$stateDir    = Join-Path $env:USERPROFILE '.claude\sessions\state'
$closeFlag   = Join-Path $env:USERPROFILE '.claude\sessions\closeoutside.flag'   # opt-in: close on outside click
$dndFlag     = Join-Path $env:USERPROFILE '.claude\sessions\dnd.flag'            # suspend auto-popup on completion
$focusOffFlag = Join-Path $env:USERPROFILE '.claude\sessions\focus-off.flag'     # opt-OUT: the nudge is ON by default, this marker disables it
$posFile     = Join-Path $env:USERPROFILE '.claude\sessions\position.txt'        # top | bottom | free
$posXFile    = Join-Path $env:USERPROFILE '.claude\sessions\posx.txt'            # custom left (px); present = user dragged a horizontal spot
$posYFile    = Join-Path $env:USERPROFILE '.claude\sessions\posy.txt'            # custom top (px); used only when position = free
$opacityFile = Join-Path $env:USERPROFILE '.claude\sessions\opacity.txt'         # 20..100 (window opacity %)
$sizeFile    = Join-Path $env:USERPROFILE '.claude\sessions\size.txt'            # 24..95 (overall scale; 42 = Normal, drives width + fonts)

# Update toggle + stats launcher (the updater bridge itself - Get-LocalVersion /
# Invoke-Updater / Get-UpdateInfo - lives in session-common.ps1 and resolves its
# own paths).
$autoUpdFlag = Join-Path $env:USERPROFILE '.claude\sessions\autoupdate.flag'
$statsVbs    = Join-Path $env:USERPROFILE '.claude\sessions\show-stats.vbs'
$recapVbs    = Join-Path $env:USERPROFILE '.claude\sessions\show-recap.vbs'
$onbVbs      = Join-Path $env:USERPROFILE '.claude\sessions\show-onboarding.vbs'   # first-run setup panel (reopenable)

# Pomodoro: the tray owns the clock + tracking and writes pomodoro.json; the deck
# header just renders it and drops control tokens into pomodoro-cmd.txt.
$pomoState   = Join-Path $env:USERPROFILE '.claude\sessions\pomodoro.json'
$pomoCmd     = Join-Path $env:USERPROFILE '.claude\sessions\pomodoro-cmd.txt'

# Focus nudge: the tray re-stamps a tick count into focus-nudge.txt every few seconds
# the whole time you stay on a distraction. We poll it on the 1s Pomodoro timer and
# hold the Matrix overlay up while the stamp is fresh, fading it once you refocus a
# real app (the stamps stop). A stale stamp at startup is simply ignored by the age
# check, so opening the deck later never replays an old nudge.
$nudgeFile   = Join-Path $env:USERPROFILE '.claude\sessions\focus-nudge.txt'

# Get-LocalVersion / Invoke-Updater / Get-UpdateInfo (the self-updater bridge) and
# Toggle-Flag now live in session-common.ps1.

# --- Favorite-workspace helpers --------------------------------------------
# Run the shared helper as a hidden child process - NEVER dot-sourced. Dot-sourcing
# a param()-block script into this WinForms scope leaked side effects that broke the
# session list rendering. This mirrors Invoke-Updater above and keeps scopes clean.
$wsHelper = Join-Path $PSScriptRoot 'session-workspaces.ps1'
$wsFile   = Join-Path $env:USERPROFILE '.claude\sessions\workspaces.json'
function Invoke-Workspaces([string]$mode, [string]$only) {
  if (-not (Test-Path $wsHelper)) { return }
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $wsHelper), $mode)
  if ($only) { $argv += @('-Only', ('"{0}"' -f $only)) }
  Start-Process powershell -WindowStyle Hidden -ArgumentList $argv -ErrorAction SilentlyContinue
}
# Saved favorites - read straight from workspaces.json (no helper needed).
function Get-FavItems {
  try { if (Test-Path $wsFile) { return @(([System.IO.File]::ReadAllText($wsFile) | ConvertFrom-Json).items) } } catch {}
  return @()
}
function Get-FavCount { return @(Get-FavItems).Count }

# Persist a curated favorites list back to workspaces.json (UTF-8 no BOM, same
# { saved, items } shape the helper reads). The deck now OWNS this file as a
# manually-managed list: the manager (Edit-Workspaces) and the row right-click
# add/remove single entries here; the old whole-set snapshot is gone.
function Save-FavItems($items) {
  try {
    $arr = @($items | ForEach-Object { [pscustomobject]@{
      app = [string]$_.app; kind = [string]$_.kind; path = [string]$_.path; name = [string]$_.name } })
    $obj = [pscustomobject]@{ saved = (Get-Date).ToString('o'); items = @($arr) }
    Write-CDText $wsFile ($obj | ConvertTo-Json -Depth 5)
  } catch {}
}
# True when $path (any app) is already a favorite.
function Test-IsFav([string]$path) {
  if (-not $path) { return $false }
  $p = $path.ToLowerInvariant()
  foreach ($it in (Get-FavItems)) { if (([string]$it.path).ToLowerInvariant() -eq $p) { return $true } }
  return $false
}
# Append one workspace, de-duplicated by app+path. Returns $true when added,
# $false when it was already there (or the path was empty).
function Add-FavWorkspace([string]$path, [string]$app, [string]$kind, [string]$name) {
  if (-not $path) { return $false }
  if (-not $app)  { $app = 'code' }
  if (-not $kind) { $kind = 'folder' }
  if (-not $name) { $name = (Split-Path $path -Leaf); if (-not $name) { $name = $path } }
  $key = '{0}|{1}' -f $app, $path.ToLowerInvariant()
  $items = New-Object System.Collections.ArrayList
  foreach ($it in (Get-FavItems)) {
    if (('{0}|{1}' -f [string]$it.app, ([string]$it.path).ToLowerInvariant()) -eq $key) { return $false }
    [void]$items.Add($it)
  }
  [void]$items.Add([pscustomobject]@{ app = $app; kind = $kind; path = $path; name = $name })
  Save-FavItems $items
  return $true
}
# Drop every favorite matching $path (any app). Returns $true when one was removed.
function Remove-FavWorkspace([string]$path) {
  if (-not $path) { return $false }
  $p = $path.ToLowerInvariant()
  $kept = @(); $removed = $false
  foreach ($it in (Get-FavItems)) {
    if (([string]$it.path).ToLowerInvariant() -eq $p) { $removed = $true; continue }
    $kept += $it
  }
  if ($removed) { Save-FavItems $kept }
  return $removed
}
# The editor windows open right now, via the shared helper's -OpenJson mode (run
# as a hidden child so there's no console flash, output captured through a temp
# file). Returns an array of { app, kind, path, name } (empty on any failure).
function Get-OpenWindowList {
  try {
    if (-not (Test-Path $wsHelper)) { return @() }
    $tmp  = [System.IO.Path]::GetTempFileName()
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $wsHelper), '-OpenJson')
    Start-Process powershell -WindowStyle Hidden -ArgumentList $argv -RedirectStandardOutput $tmp -PassThru -Wait | Out-Null
    $raw = [System.IO.File]::ReadAllText($tmp)
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    if (-not $raw -or -not $raw.Trim()) { return @() }
    return @($raw | ConvertFrom-Json)
  } catch { return @() }
}

# --- Per-project objectives (a scrollable one-line todo list) ---------------
# Each project carries a manually-typed TODO list, shared by ALL of that project's
# sessions. Stored as { items: { "<project>": [ { text, done }, ... ] } } in
# objectives.json (UTF-8 no BOM via Write-CDText). A legacy single string is read
# as one undone task (see ConvertTo-CDTasks in session-common.ps1), so old files
# keep working. Re-read on every refresh so an edit shows live.
#
# The header bar stays ONE line: it shows a single task at a time plus an "i/n"
# counter, and the mouse wheel (captured app-wide via [WheelFilter], since the
# overlay never takes focus) cycles through the list. $script:objSel remembers the
# scrolled-to index per project (in-memory UI state; survives row rebuilds).
# Resolved via Get-CDObjectivesPath on every read/write, NOT cached: the cloud-sync
# folder can be set/changed at runtime from the gear menu, so the path must follow it.
$script:objectives = @{}     # project -> @( [pscustomobject]@{ text; done } )
$script:objSel     = @{}     # project -> selected task index (wheel position)
function Read-Objectives {
  $script:objectives = @{}
  try {
    $objFile = Get-CDObjectivesPath
    if (Test-Path $objFile) {
      $o = [System.IO.File]::ReadAllText($objFile) | ConvertFrom-Json
      if ($o -and $o.items) {
        foreach ($p in $o.items.PSObject.Properties) { $script:objectives[$p.Name] = @(ConvertTo-CDTasks $p.Value) }
      }
    }
  } catch {}
}
function Get-Tasks([string]$project) {
  if (-not $project) { return @() }
  if ($script:objectives.ContainsKey($project)) { return @($script:objectives[$project]) }
  return @()
}
# The deck's one-line todo bar shows/cycles ONLY open (not-done) tasks: completed
# tasks are hidden from the bar entirely and live on only in the editor (pencil) and
# in objectives.json. Elements are the SAME objects as in Get-Tasks, so toggling one
# here is reflected in the full list before persisting. The wheel index ($objSel) is
# an index into THIS filtered list.
function Get-OpenTasks([string]$project) {
  return @(Get-Tasks $project | Where-Object { -not $_.done })
}
# The wheel index for a project, clamped to the current task count (wraps).
function Get-ObjSel([string]$project, [int]$count) {
  $i = 0
  if ($script:objSel.ContainsKey($project)) { $i = [int]$script:objSel[$project] }
  if ($count -le 0) { $i = 0 } else { $i = (($i % $count) + $count) % $count }
  $script:objSel[$project] = $i
  return $i
}
# First view of a project (no wheel position yet): start at the first open task.
# The bar only ever shows open tasks (Get-OpenTasks), so index 0 is already the first
# thing left to do. Once the user scrolls, $script:objSel holds their pick and this
# leaves it alone. A real function (not a closure) so the write lands in script scope.
function Ensure-ObjSel([string]$project) {
  if (-not $project -or $script:objSel.ContainsKey($project)) { return }
  $script:objSel[$project] = 0
}
# A compact content signature (done-state + text) so an edit elsewhere repaints.
# The scrolled-to index is deliberately NOT part of it: wheel cycling updates the
# header in place, so it must not trigger a full row rebuild.
function Get-ObjSig([string]$project) {
  $parts = @(Get-Tasks $project | ForEach-Object { ($(if ($_.done) { '1' } else { '0' })) + [string]$_.text })
  return ($parts -join '~')
}
# Save (or clear, when empty) a project's task list, then persist the whole map.
function Set-Tasks([string]$project, $tasks) {
  if (-not $project) { return }
  Read-Objectives                                      # merge onto the latest on-disk map
  $tasks = @($tasks | Where-Object { $_ -and ([string]$_.text).Trim() })
  if ($tasks.Count -gt 0) { $script:objectives[$project] = @($tasks) }
  elseif ($script:objectives.ContainsKey($project)) { $script:objectives.Remove($project) }
  $items = New-Object psobject
  foreach ($k in $script:objectives.Keys) {
    $arr = @($script:objectives[$k] | ForEach-Object { [pscustomobject]@{ text = ([string]$_.text).Trim(); done = [bool]$_.done; desc = [string]$_.desc } })
    $items | Add-Member -NotePropertyName $k -NotePropertyValue $arr
  }
  try { Write-CDText (Get-CDObjectivesPath) ([pscustomobject]@{ items = $items } | ConvertTo-Json -Depth 6) } catch {}
}

# A tiny dark single-line input dialog. Returns the typed text on OK (may be empty)
# or $null on Cancel. Used by the task editor for Add / Edit. Suppresses the deck's
# click-outside-close while open (same guard as the settings menu).
function Read-Line([string]$title, [string]$initial) {
  $script:menuOpen = $true
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text            = $title
  $dlg.FormBorderStyle = 'FixedDialog'
  $dlg.StartPosition   = 'CenterScreen'
  $dlg.TopMost         = $true
  $dlg.MaximizeBox     = $false
  $dlg.MinimizeBox     = $false
  $dlg.ShowInTaskbar   = $false
  $dlg.BackColor       = $bg
  $dlg.ForeColor       = $white
  $dlg.ClientSize      = New-Object System.Drawing.Size(480, 96)
  try { if (Test-Path $iconPath) { $dlg.Icon = New-Object System.Drawing.Icon($iconPath) } } catch {}

  $txt = New-Object System.Windows.Forms.TextBox
  $txt.Text        = [string]$initial
  $txt.BackColor   = $rowBg
  $txt.ForeColor   = $white
  $txt.BorderStyle = 'FixedSingle'
  $txt.Font        = New-Object System.Drawing.Font('Segoe UI', 12)
  $txt.Location    = New-Object System.Drawing.Point(16, 16)
  $txt.Size        = New-Object System.Drawing.Size(448, 28)
  $txt.MaxLength   = 200
  $dlg.Controls.Add($txt)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'OK'; $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.FlatStyle = 'Flat'; $ok.ForeColor = $white; $ok.BackColor = $rowBg
  $ok.Size = New-Object System.Drawing.Size(96, 30)
  $ok.Location = New-Object System.Drawing.Point(264, 52)
  $dlg.Controls.Add($ok)

  $cl = New-Object System.Windows.Forms.Button
  $cl.Text = 'Cancel'; $cl.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cl.FlatStyle = 'Flat'; $cl.ForeColor = $grey; $cl.BackColor = $rowBg
  $cl.Size = New-Object System.Drawing.Size(96, 30)
  $cl.Location = New-Object System.Drawing.Point(368, 52)
  $dlg.Controls.Add($cl)

  $dlg.AcceptButton = $ok
  $dlg.CancelButton = $cl
  $dlg.Add_Shown({ $txt.Focus(); $txt.SelectAll() }.GetNewClosure())

  $res = $dlg.ShowDialog()
  $val = $txt.Text
  $dlg.Dispose()
  $script:menuOpen = $false
  $script:shownAt  = [Environment]::TickCount   # re-arm the click-outside grace
  if ($res -eq [System.Windows.Forms.DialogResult]::OK) { return $val }
  return $null
}

# A larger, resizable task-detail dialog: a single-line title field on top and a
# rich-text note below (RichTextBox with a Bold / Italic / Bullet toolbar, plus
# Ctrl+B / Ctrl+I). Used by the task editor for Add / Edit. Returns a hashtable
# @{ text; desc } on OK (desc is RTF, or '' when the note is blank) or $null on
# Cancel. The note round-trips as RTF — pure ASCII, so it survives PS 5.1 encoding.
# Suppresses the deck's click-outside-close while open (same guard as Read-Line).
function Edit-TaskDetail([string]$title, [string]$initialText, [string]$initialDesc) {
  $script:menuOpen = $true
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text            = $title
  $dlg.FormBorderStyle = 'Sizable'
  $dlg.StartPosition   = 'CenterScreen'
  $dlg.TopMost         = $true
  $dlg.MaximizeBox     = $true
  $dlg.MinimizeBox     = $false
  $dlg.ShowInTaskbar   = $false
  $dlg.BackColor       = $bg
  $dlg.ForeColor       = $white
  $dlg.Font            = New-Object System.Drawing.Font('Segoe UI', 9.75)
  $dlg.ClientSize      = New-Object System.Drawing.Size(560, 460)
  $dlg.MinimumSize     = New-Object System.Drawing.Size(420, 320)
  try { if (Test-Path $iconPath) { $dlg.Icon = New-Object System.Drawing.Icon($iconPath) } } catch {}

  $accent = Get-CDAccent

  # Title field (single line) -----------------------------------------------
  $lblT = New-Object System.Windows.Forms.Label
  $lblT.Text = 'Title'; $lblT.AutoSize = $true; $lblT.ForeColor = $grey
  $lblT.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $lblT.Location = New-Object System.Drawing.Point(16, 14)
  $dlg.Controls.Add($lblT)

  $txt = New-Object System.Windows.Forms.TextBox
  $txt.Text        = [string]$initialText
  $txt.BackColor   = $rowBg
  $txt.ForeColor   = $white
  $txt.BorderStyle = 'FixedSingle'
  $txt.Font        = New-Object System.Drawing.Font('Segoe UI', 12)
  $txt.Location    = New-Object System.Drawing.Point(16, 34)
  $txt.Size        = New-Object System.Drawing.Size(528, 28)
  $txt.Anchor      = 'Top,Left,Right'
  $txt.MaxLength   = 200
  $dlg.Controls.Add($txt)

  # Description label + formatting toolbar ----------------------------------
  $lblD = New-Object System.Windows.Forms.Label
  $lblD.Text = 'Description'; $lblD.AutoSize = $true; $lblD.ForeColor = $grey
  $lblD.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $lblD.Location = New-Object System.Drawing.Point(16, 76)
  $dlg.Controls.Add($lblD)

  # The note editor (built before the toolbar so the toolbar handlers capture it).
  $rtb = New-Object System.Windows.Forms.RichTextBox
  $rtb.BackColor   = $rowBg
  $rtb.ForeColor   = $white
  $rtb.BorderStyle = 'FixedSingle'
  $rtb.Font        = New-Object System.Drawing.Font('Segoe UI', 11)
  $rtb.Location    = New-Object System.Drawing.Point(16, 128)
  $rtb.Size        = New-Object System.Drawing.Size(528, 280)
  $rtb.Anchor      = 'Top,Bottom,Left,Right'
  $rtb.AcceptsTab  = $false
  $rtb.HideSelection = $false
  $rtb.DetectUrls  = $false
  # RTF round-trips faithfully; a blank/legacy desc is loaded as plain text.
  if ($initialDesc -and $initialDesc.TrimStart().StartsWith('{\rtf')) {
    try { $rtb.Rtf = $initialDesc } catch { $rtb.Text = '' }
  } else {
    $rtb.Text = [string]$initialDesc
  }
  $dlg.Controls.Add($rtb)

  $lighten = { param($c, $d) [System.Drawing.Color]::FromArgb([math]::Min(255, $c.R + $d), [math]::Min(255, $c.G + $d), [math]::Min(255, $c.B + $d)) }
  $mkTool = {
    param([string]$text, [int]$left, [string]$tip, $font)
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.Size = New-Object System.Drawing.Size(34, 28)
    $b.Location = New-Object System.Drawing.Point($left, 98)
    $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderSize = 0
    $b.BackColor = $rowBg; $b.ForeColor = $white
    $b.FlatAppearance.MouseOverBackColor = (& $lighten $rowBg 18)
    $b.FlatAppearance.MouseDownBackColor = (& $lighten $rowBg 30)
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    $b.UseVisualStyleBackColor = $false
    $b.TabStop = $false
    if ($font) { $b.Font = $font }
    $dlg.Controls.Add($b)
    return $b
  }

  # Toggle a font-style bit (Bold/Italic) over the current selection. Mixed-font
  # selections report a $null SelectionFont, so we fall back to the box font.
  $toggleStyle = {
    param([System.Drawing.FontStyle]$style)
    $f = $rtb.SelectionFont; if (-not $f) { $f = $rtb.Font }
    $ns = if ($f.Style -band $style) { $f.Style -bxor $style } else { $f.Style -bor $style }
    $rtb.SelectionFont = New-Object System.Drawing.Font($f.FontFamily, $f.Size, $ns)
    $rtb.Focus()
  }.GetNewClosure()

  $bBold = & $mkTool 'B' 16 'Bold (Ctrl+B)' (New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold))
  $bBold.Add_Click({ & $toggleStyle ([System.Drawing.FontStyle]::Bold) }.GetNewClosure())
  $bItal = & $mkTool 'I' 54 'Italic (Ctrl+I)' (New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Italic))
  $bItal.Add_Click({ & $toggleStyle ([System.Drawing.FontStyle]::Italic) }.GetNewClosure())
  $bBul = & $mkTool ([string][char]0x2022 + ' List') 92 'Bullet list' (New-Object System.Drawing.Font('Segoe UI', 9.75))
  $bBul.Size = New-Object System.Drawing.Size(64, 28)
  $bBul.Add_Click({ $rtb.SelectionBullet = -not $rtb.SelectionBullet; $rtb.Focus() }.GetNewClosure())

  # Ctrl+B / Ctrl+I keyboard shortcuts inside the note.
  $rtb.Add_KeyDown({
    if ($_.Control -and $_.KeyCode -eq [System.Windows.Forms.Keys]::B) { & $toggleStyle ([System.Drawing.FontStyle]::Bold); $_.SuppressKeyPress = $true }
    elseif ($_.Control -and $_.KeyCode -eq [System.Windows.Forms.Keys]::I) { & $toggleStyle ([System.Drawing.FontStyle]::Italic); $_.SuppressKeyPress = $true }
  }.GetNewClosure())

  # Save / Cancel (anchored bottom-right; Save carries the brand accent) -----
  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'Save'; $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Size = New-Object System.Drawing.Size(110, 32)
  $ok.Location = New-Object System.Drawing.Point(322, 418)
  $ok.Anchor = 'Bottom,Right'
  $ok.FlatStyle = 'Flat'; $ok.FlatAppearance.BorderSize = 0
  $ok.BackColor = $accent; $ok.ForeColor = (Get-TextOn $accent)
  $ok.FlatAppearance.MouseOverBackColor = (& $lighten $accent 18)
  $ok.Cursor = [System.Windows.Forms.Cursors]::Hand
  $ok.UseVisualStyleBackColor = $false
  $dlg.Controls.Add($ok)

  $cl = New-Object System.Windows.Forms.Button
  $cl.Text = 'Cancel'; $cl.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cl.Size = New-Object System.Drawing.Size(110, 32)
  $cl.Location = New-Object System.Drawing.Point(436, 418)
  $cl.Anchor = 'Bottom,Right'
  $cl.FlatStyle = 'Flat'; $cl.FlatAppearance.BorderSize = 0
  $cl.BackColor = $rowBg; $cl.ForeColor = $grey
  $cl.FlatAppearance.MouseOverBackColor = (& $lighten $rowBg 18)
  $cl.Cursor = [System.Windows.Forms.Cursors]::Hand
  $cl.UseVisualStyleBackColor = $false
  $dlg.Controls.Add($cl)

  $dlg.CancelButton = $cl
  $dlg.Add_Shown({ $txt.Focus(); $txt.SelectAll() }.GetNewClosure())

  $res = $dlg.ShowDialog()
  $outText = ([string]$txt.Text).Trim()
  # Store '' when the note is blank, so callers can test `if ($t.desc)` cleanly.
  $outDesc = if (([string]$rtb.Text).Trim()) { $rtb.Rtf } else { '' }
  $dlg.Dispose()
  $script:menuOpen = $false
  $script:shownAt  = [Environment]::TickCount   # re-arm the click-outside grace
  if ($res -eq [System.Windows.Forms.DialogResult]::OK) { return @{ text = $outText; desc = $outDesc } }
  return $null
}

# Forces the next Refresh-List to rebuild (clears the anti-flicker signature). A
# real function so it works from inside GetNewClosure'd handlers — a $script: write
# in such a block lands in the closure's own module scope, not the script's.
function Invalidate-List { $script:lastSig = $null }

# --- Task editor: shared state + operations (driven by Edit-Tasks) ----------
# The editor's list is driven by these top-level helpers rather than in-place
# closures so the per-row event handlers (which MUST use GetNewClosure to capture
# their own row index) can reach the shared state simply by CALLING them: a
# function runs in the real script scope, so its $script: reads/writes and the
# $script:MAT glyph lookups resolve correctly (a GetNewClosure'd block would see an
# empty $script:). All state is (re)set by Edit-Tasks each time it opens.
$script:etTasks = $null   # the working ArrayList of { text; done }
$script:etSel   = -1      # selected row index (-1 = none)
$script:etRows  = @()     # the row panels, parallel to $script:etTasks

# Highlight the selected row: lighter bg + a project-coloured left bar.
function ET-ApplySel {
  for ($i = 0; $i -lt $script:etRows.Count; $i++) {
    $rp = $script:etRows[$i]
    if ($i -eq $script:etSel) { $rp.BackColor = $script:etRowSel; $rp.Tag.bar.Visible = $true }
    else { $rp.BackColor = $script:etRowIdle; $rp.Tag.bar.Visible = $false }
  }
}
# Paint a row's checkbox + text from its backing task (done -> green tick + strike).
function ET-RenderRow($rp) {
  $m = $rp.Tag
  $t = $script:etTasks[$m.idx]
  if ($t.done) {
    $m.check.Text = Get-IconChar $script:MAT.checkOn 0x2611; $m.check.ForeColor = $green
    $m.text.Font  = $script:etFontDone; $m.text.ForeColor = $script:etDone
  } else {
    $m.check.Text = Get-IconChar $script:MAT.checkOff 0x2610; $m.check.ForeColor = $script:etChkOff
    $m.text.Font  = $script:etFontTask; $m.text.ForeColor = $white
  }
  $m.text.Text = [string]$t.text
  # A faint notes glyph flags tasks that carry a rich-text description.
  $m.note.Visible = [bool]([string]$t.desc).Trim()
}
function ET-Footer {
  $n = $script:etTasks.Count
  $d = @($script:etTasks | Where-Object { $_.done }).Count
  if ($n -eq 0) { $script:etFooter.Text = 'No tasks yet' }
  else { $script:etFooter.Text = ('{0} task{1}' -f $n, $(if ($n -eq 1) { '' } else { 's' })) + (' ' + [char]0x00B7 + ' {0} done' -f $d) }
}
function ET-Select([int]$idx) { $script:etSel = $idx; ET-ApplySel }
function ET-Toggle([int]$idx) {
  if ($idx -lt 0 -or $idx -ge $script:etTasks.Count) { return }
  $script:etSel = $idx; ET-ApplySel
  $script:etTasks[$idx].done = -not [bool]$script:etTasks[$idx].done
  ET-RenderRow $script:etRows[$idx]
  ET-Footer
}
# Build one row panel (left accent bar + clickable check glyph + task text). The
# handlers capture $idx via GetNewClosure and just call the ET-* operations.
function ET-MakeRow([int]$idx) {
  $rp = New-Object System.Windows.Forms.Panel
  $rp.Width = $script:etRowW; $rp.Height = 34
  $rp.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 4)
  $rp.BackColor = $script:etRowIdle
  $rp.Cursor = [System.Windows.Forms.Cursors]::Hand

  $bar = New-Object System.Windows.Forms.Panel
  $bar.Dock = 'Left'; $bar.Width = 3; $bar.BackColor = $script:etProjCol; $bar.Visible = $false
  $rp.Controls.Add($bar)

  $chk = New-Object System.Windows.Forms.Label
  $chk.UseCompatibleTextRendering = $true
  $chk.Font = $script:etFontChk; $chk.AutoSize = $true
  $chk.BackColor = [System.Drawing.Color]::Transparent; $chk.Cursor = [System.Windows.Forms.Cursors]::Hand
  $chk.Location = New-Object System.Drawing.Point(13, 7)
  $rp.Controls.Add($chk)

  $note = New-Object System.Windows.Forms.Label
  $note.UseCompatibleTextRendering = $true
  $note.Font = $script:etFontNote; $note.AutoSize = $true
  $note.Text = Get-IconChar $script:MAT.notes 0x2630
  $note.ForeColor = $script:etChkOff
  $note.BackColor = [System.Drawing.Color]::Transparent
  $note.Cursor = [System.Windows.Forms.Cursors]::Hand
  $note.Location = New-Object System.Drawing.Point(($script:etRowW - 24), 9)
  $note.Anchor = 'Top,Right'
  $note.Visible = $false
  $rp.Controls.Add($note)

  $txt = New-Object System.Windows.Forms.Label
  $txt.AutoSize = $false; $txt.TextAlign = 'MiddleLeft'; $txt.AutoEllipsis = $true
  $txt.BackColor = [System.Drawing.Color]::Transparent; $txt.Cursor = [System.Windows.Forms.Cursors]::Hand
  $txt.Location = New-Object System.Drawing.Point(42, 0)
  $txt.Size = New-Object System.Drawing.Size(($script:etRowW - 42 - 28), 34)
  $rp.Controls.Add($txt)

  $rp.Tag = @{ bar = $bar; check = $chk; text = $txt; note = $note; idx = $idx }

  $selectThis = { ET-Select $idx }.GetNewClosure()
  $rp.Add_Click($selectThis)
  $txt.Add_Click($selectThis)
  $txt.Add_DoubleClick({ ET-Edit }.GetNewClosure())
  $note.Add_Click({ ET-Select $idx; ET-Edit }.GetNewClosure())
  $chk.Add_Click({ ET-Toggle $idx }.GetNewClosure())
  $rp.Add_MouseEnter({ if ($script:etSel -ne $idx) { $this.BackColor = $script:etRowHov } }.GetNewClosure())
  $rp.Add_MouseLeave({ if ($script:etSel -ne $idx) { $this.BackColor = $script:etRowIdle } }.GetNewClosure())

  ET-RenderRow $rp
  return $rp
}
# Rebuild every row from the backing list, then re-apply selection + footer.
function ET-Fill([int]$select) {
  $script:etLst.SuspendLayout()
  $script:etLst.Controls.Clear()
  $script:etRows = @()
  if ($script:etTasks.Count -eq 0) {
    $empty = New-Object System.Windows.Forms.Label
    $empty.Text = 'No tasks yet ' + [char]0x2014 + ' click Add to create one'
    $empty.AutoSize = $true; $empty.ForeColor = $grey
    $empty.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Italic)
    $empty.Margin = New-Object System.Windows.Forms.Padding(6, 10, 6, 6)
    $script:etLst.Controls.Add($empty)
    $script:etSel = -1
  } else {
    for ($i = 0; $i -lt $script:etTasks.Count; $i++) {
      $rp = ET-MakeRow $i
      $script:etLst.Controls.Add($rp)
      $script:etRows += $rp
    }
    if ($select -lt 0) { $select = 0 }
    if ($select -ge $script:etTasks.Count) { $select = $script:etTasks.Count - 1 }
    $script:etSel = $select
  }
  $script:etLst.ResumeLayout()
  ET-ApplySel
  ET-Footer
}
function ET-Edit {
  $i = $script:etSel
  if ($i -lt 0 -or $i -ge $script:etTasks.Count) { return }
  $t = $script:etTasks[$i]
  $v = Edit-TaskDetail ('Edit task ' + [char]0x2014 + ' ' + $script:etProject) ([string]$t.text) ([string]$t.desc)
  if ($null -ne $v -and ([string]$v.text).Trim()) {
    $t.text = ([string]$v.text).Trim(); $t.desc = [string]$v.desc; ET-Fill $i
  }
}
function ET-Add {
  $v = Edit-TaskDetail ('Add task ' + [char]0x2014 + ' ' + $script:etProject) '' ''
  if ($null -ne $v -and ([string]$v.text).Trim()) {
    [void]$script:etTasks.Add([pscustomobject]@{ text = ([string]$v.text).Trim(); done = $false; desc = [string]$v.desc })
    ET-Fill ($script:etTasks.Count - 1)
  }
}
function ET-Delete {
  $i = $script:etSel
  if ($i -lt 0 -or $i -ge $script:etTasks.Count) { return }
  $script:etTasks.RemoveAt($i); ET-Fill $i
}
function ET-Move([int]$dir) {
  $i = $script:etSel; $j = $i + $dir
  if ($i -lt 0 -or $j -lt 0 -or $j -ge $script:etTasks.Count) { return }
  $tmp = $script:etTasks[$i]; $script:etTasks.RemoveAt($i); $script:etTasks.Insert($j, $tmp); ET-Fill $j
}

# The full task-list editor (opened from the header pencil): add / edit / delete /
# reorder / toggle-done in one dialog. A custom dark row list (the tick = done) sits
# left, the action buttons right. Returns the edited task list on Save, or $null on
# Cancel. Suppresses the click-outside-close while open.
function Edit-Tasks([string]$project) {
  $tasks = New-Object System.Collections.ArrayList
  foreach ($t in (Get-Tasks $project)) { [void]$tasks.Add([pscustomobject]@{ text = [string]$t.text; done = [bool]$t.done; desc = [string]$t.desc }) }

  $script:menuOpen = $true
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text            = ('Tasks ' + [char]0x2014 + ' ' + $project)
  $dlg.FormBorderStyle = 'FixedDialog'
  $dlg.StartPosition   = 'CenterScreen'
  $dlg.TopMost         = $true
  $dlg.MaximizeBox     = $false
  $dlg.MinimizeBox     = $false
  $dlg.ShowInTaskbar   = $false
  $dlg.BackColor       = $bg
  $dlg.ForeColor       = $white
  $dlg.Font            = New-Object System.Drawing.Font('Segoe UI', 9.75)
  $dlg.ClientSize      = New-Object System.Drawing.Size(600, 412)
  try { if (Test-Path $iconPath) { $dlg.Icon = New-Object System.Drawing.Icon($iconPath) } } catch {}

  # --- palette / fonts (read by the ET-* editor helpers via $script:) -------
  $accent  = Get-CDAccent
  $projCol = Get-ProjectColor $project
  $script:etProject  = $project
  $script:etTasks    = $tasks
  $script:etProjCol  = $projCol
  $canvasBg          = [System.Drawing.Color]::FromArgb(20, 20, 24)    # list canvas (rows sit on it)
  $script:etRowIdle  = $rowBg
  $script:etRowHov   = [System.Drawing.Color]::FromArgb(46, 46, 54)
  $script:etRowSel   = [System.Drawing.Color]::FromArgb(58, 58, 70)
  $script:etChkOff   = [System.Drawing.Color]::FromArgb(140, 140, 150)
  $script:etDone     = [System.Drawing.Color]::FromArgb(125, 125, 135)
  $script:etFontTask = New-Object System.Drawing.Font('Segoe UI', 11)
  $script:etFontDone = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Strikeout)
  $script:etFontChk  = New-IconFont ([single]13)
  $script:etFontNote = New-IconFont ([single]11)

  # Project-coloured dot + name, with a usage hint on the right.
  $dot = New-Object System.Windows.Forms.Label
  $dot.AutoSize = $false; $dot.Size = New-Object System.Drawing.Size(10, 10)
  $dot.Location = New-Object System.Drawing.Point(20, 19); $dot.BackColor = $projCol
  $dlg.Controls.Add($dot)
  $sub = New-Object System.Windows.Forms.Label
  $sub.Text = $project; $sub.AutoSize = $true; $sub.ForeColor = $white
  $sub.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $sub.Location = New-Object System.Drawing.Point(38, 13)
  $dlg.Controls.Add($sub)
  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = 'click ' + [char]0x2610 + ' to tick' + [char]0x2002 + [char]0x00B7 + [char]0x2002 + 'double-click to edit'
  $hint.AutoSize = $true; $hint.ForeColor = $grey
  $hint.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $dlg.Controls.Add($hint)
  $hint.Location = New-Object System.Drawing.Point((416 - $hint.PreferredWidth), 18)

  # List canvas: a 1px-bordered wrapper around a scrollable TopDown flow of rows.
  $wrap = New-Object System.Windows.Forms.Panel
  $wrap.Location  = New-Object System.Drawing.Point(20, 44)
  $wrap.Size      = New-Object System.Drawing.Size(396, 328)
  $wrap.BackColor = [System.Drawing.Color]::FromArgb(60, 60, 70)   # shows as the 1px frame
  $dlg.Controls.Add($wrap)
  $lst = New-Object System.Windows.Forms.FlowLayoutPanel
  $lst.Location      = New-Object System.Drawing.Point(1, 1)
  $lst.Size          = New-Object System.Drawing.Size(394, 326)
  $lst.FlowDirection = 'TopDown'
  $lst.WrapContents  = $false
  $lst.AutoScroll    = $true
  $lst.BackColor     = $canvasBg
  $lst.Padding       = New-Object System.Windows.Forms.Padding(6, 6, 6, 6)
  $wrap.Controls.Add($lst)
  $script:etLst  = $lst
  $script:etRowW = $lst.ClientSize.Width - [System.Windows.Forms.SystemInformation]::VerticalScrollBarWidth - 14
  $script:etSel  = 0
  $script:etRows = @()

  # --- side buttons --------------------------------------------------------
  # The style helpers run synchronously at build time, so they stay plain
  # scriptblocks; all row/list logic lives in the ET-* functions above, which the
  # button handlers just call (so the real $script: state is reached correctly).
  $lighten = { param($c, $d) [System.Drawing.Color]::FromArgb([math]::Min(255, $c.R + $d), [math]::Min(255, $c.G + $d), [math]::Min(255, $c.B + $d)) }
  $styleBtn = {
    param($b, [string]$kind)
    $b.FlatStyle = 'Flat'
    $b.FlatAppearance.BorderSize = 0
    $b.Font   = New-Object System.Drawing.Font('Segoe UI', 9.75)
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    $b.UseVisualStyleBackColor = $false
    $b.TextAlign = 'MiddleCenter'
    if ($kind -eq 'accent')     { $base = $accent; $fore = Get-TextOn $accent }
    elseif ($kind -eq 'danger') { $base = $rowBg;  $fore = [System.Drawing.Color]::FromArgb(232, 124, 112) }
    elseif ($kind -eq 'muted')  { $base = $rowBg;  $fore = $grey }
    else                        { $base = $rowBg;  $fore = $white }
    $b.BackColor = $base; $b.ForeColor = $fore
    $b.FlatAppearance.MouseOverBackColor = (& $lighten $base 18)
    $b.FlatAppearance.MouseDownBackColor = (& $lighten $base 30)
  }
  $mkBtn = {
    param([string]$text, [int]$top, [string]$kind)
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.Size = New-Object System.Drawing.Size(150, 34)
    $b.Location = New-Object System.Drawing.Point(432, $top)
    & $styleBtn $b $kind
    $dlg.Controls.Add($b)
    return $b
  }

  $bAdd = & $mkBtn ([char]0x002B + '  Add')              44  'default'
  $bEd  = & $mkBtn 'Edit'                                82  'default'
  $bDel = & $mkBtn 'Delete'                              120 'danger'
  $bUp  = & $mkBtn ([char]0x2191 + '  Move up')          176 'default'
  $bDn  = & $mkBtn ([char]0x2193 + '  Move down')        214 'default'

  $bAdd.Add_Click({ ET-Add })
  $bEd.Add_Click({ ET-Edit })
  $bDel.Add_Click({ ET-Delete })
  $bUp.Add_Click({ ET-Move -1 })
  $bDn.Add_Click({ ET-Move 1 })

  # Footer count, bottom-left, aligned with the Save/Cancel row.
  $footer = New-Object System.Windows.Forms.Label
  $footer.AutoSize = $true; $footer.ForeColor = $grey
  $footer.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $footer.Location = New-Object System.Drawing.Point(20, 388)
  $dlg.Controls.Add($footer)
  $script:etFooter = $footer

  # Save / Cancel (Save carries the brand accent).
  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'Save'; $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Size = New-Object System.Drawing.Size(150, 34)
  $ok.Location = New-Object System.Drawing.Point(432, 300)
  & $styleBtn $ok 'accent'
  $dlg.Controls.Add($ok)

  $cl = New-Object System.Windows.Forms.Button
  $cl.Text = 'Cancel'; $cl.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cl.Size = New-Object System.Drawing.Size(150, 34)
  $cl.Location = New-Object System.Drawing.Point(432, 338)
  & $styleBtn $cl 'muted'
  $dlg.Controls.Add($cl)

  $dlg.AcceptButton = $ok
  $dlg.CancelButton = $cl
  ET-Fill 0

  $res = $dlg.ShowDialog()
  $dlg.Dispose()
  $script:menuOpen = $false
  $script:shownAt  = [Environment]::TickCount   # re-arm the click-outside grace
  if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
    return @($script:etTasks | ForEach-Object { [pscustomobject]@{ text = [string]$_.text; done = [bool]$_.done; desc = [string]$_.desc } })
  }
  return $null
}

# --- Favorite-workspace manager: shared state + operations ------------------
# Mirrors the task editor's design (top-level WE-* helpers, not closures, so the
# per-row handlers reach the real $script: state by CALLING them). The list is a
# curated set of { app, kind, path, name } items persisted to workspaces.json.
$script:weItems = $null   # working ArrayList of { app; kind; path; name }
$script:weSel   = -1      # selected row index (-1 = none)
$script:weRows  = @()     # row panels, parallel to $script:weItems

# A stable accent for a row's left bar: blue for VS Code, violet for Cursor.
function WE-AppColor([string]$app) {
  if ($app -eq 'cursor') { return [System.Drawing.Color]::FromArgb(163, 113, 247) }
  return [System.Drawing.Color]::FromArgb(59, 130, 246)
}
function WE-ApplySel {
  for ($i = 0; $i -lt $script:weRows.Count; $i++) {
    $rp = $script:weRows[$i]
    if ($i -eq $script:weSel) { $rp.BackColor = $script:etRowSel; $rp.Tag.bar.Visible = $true }
    else { $rp.BackColor = $script:etRowIdle; $rp.Tag.bar.Visible = $false }
  }
}
function WE-Footer {
  $n = $script:weItems.Count
  if ($n -eq 0) { $script:weFooter.Text = 'No favorites yet' }
  else { $script:weFooter.Text = ('{0} workspace{1}' -f $n, $(if ($n -eq 1) { '' } else { 's' })) }
}
function WE-Select([int]$idx) { $script:weSel = $idx; WE-ApplySel }
# Build one row: app-coloured left bar + name (white) + dim path, both ellipsized.
function WE-MakeRow([int]$idx) {
  $it = $script:weItems[$idx]
  $rp = New-Object System.Windows.Forms.Panel
  $rp.Width = $script:weRowW; $rp.Height = 38
  $rp.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 4)
  $rp.BackColor = $script:etRowIdle
  $rp.Cursor = [System.Windows.Forms.Cursors]::Hand

  $bar = New-Object System.Windows.Forms.Panel
  $bar.Dock = 'Left'; $bar.Width = 3; $bar.BackColor = (WE-AppColor ([string]$it.app)); $bar.Visible = $false
  $rp.Controls.Add($bar)

  $name = New-Object System.Windows.Forms.Label
  $name.AutoSize = $false; $name.TextAlign = 'MiddleLeft'; $name.AutoEllipsis = $true
  $name.Font = New-Object System.Drawing.Font('Segoe UI', 10.5, [System.Drawing.FontStyle]::Bold)
  $name.ForeColor = $white; $name.BackColor = [System.Drawing.Color]::Transparent
  $name.Cursor = [System.Windows.Forms.Cursors]::Hand
  $name.Location = New-Object System.Drawing.Point(14, 3)
  $name.Size = New-Object System.Drawing.Size(($script:weRowW - 20), 18)
  $name.Text = [string]$it.name
  $rp.Controls.Add($name)

  $path = New-Object System.Windows.Forms.Label
  $path.AutoSize = $false; $path.TextAlign = 'MiddleLeft'; $path.AutoEllipsis = $true
  $path.Font = New-Object System.Drawing.Font('Segoe UI', 8.25)
  $path.ForeColor = $grey; $path.BackColor = [System.Drawing.Color]::Transparent
  $path.Cursor = [System.Windows.Forms.Cursors]::Hand
  $path.Location = New-Object System.Drawing.Point(14, 19)
  $path.Size = New-Object System.Drawing.Size(($script:weRowW - 20), 16)
  $path.Text = [string]$it.path
  $rp.Controls.Add($path)

  $rp.Tag = @{ bar = $bar; idx = $idx }

  $selectThis = { WE-Select $idx }.GetNewClosure()
  $rp.Add_Click($selectThis); $name.Add_Click($selectThis); $path.Add_Click($selectThis)
  $rp.Add_MouseEnter({ if ($script:weSel -ne $idx) { $this.BackColor = $script:etRowHov } }.GetNewClosure())
  $rp.Add_MouseLeave({ if ($script:weSel -ne $idx) { $this.BackColor = $script:etRowIdle } }.GetNewClosure())
  return $rp
}
function WE-Fill([int]$select) {
  $script:weLst.SuspendLayout()
  $script:weLst.Controls.Clear()
  $script:weRows = @()
  if ($script:weItems.Count -eq 0) {
    $empty = New-Object System.Windows.Forms.Label
    $empty.Text = 'No favorites yet ' + [char]0x2014 + ' click Add to pick from open windows'
    $empty.AutoSize = $true; $empty.ForeColor = $grey
    $empty.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Italic)
    $empty.Margin = New-Object System.Windows.Forms.Padding(6, 10, 6, 6)
    $script:weLst.Controls.Add($empty)
    $script:weSel = -1
  } else {
    for ($i = 0; $i -lt $script:weItems.Count; $i++) {
      $rp = WE-MakeRow $i
      $script:weLst.Controls.Add($rp)
      $script:weRows += $rp
    }
    if ($select -lt 0) { $select = 0 }
    if ($select -ge $script:weItems.Count) { $select = $script:weItems.Count - 1 }
    $script:weSel = $select
  }
  $script:weLst.ResumeLayout()
  WE-ApplySel
  WE-Footer
}
function WE-Delete {
  $i = $script:weSel
  if ($i -lt 0 -or $i -ge $script:weItems.Count) { return }
  $script:weItems.RemoveAt($i); WE-Fill $i
}
function WE-Move([int]$dir) {
  $i = $script:weSel; $j = $i + $dir
  if ($i -lt 0 -or $j -lt 0 -or $j -ge $script:weItems.Count) { return }
  $tmp = $script:weItems[$i]; $script:weItems.RemoveAt($i); $script:weItems.Insert($j, $tmp); WE-Fill $j
}
# Add via the open-windows picker, skipping any that are already in the list.
function WE-Add {
  $picked = Pick-OpenWorkspaces
  if (-not $picked) { return }
  $seen = @{}
  foreach ($it in $script:weItems) { $seen['{0}|{1}' -f [string]$it.app, ([string]$it.path).ToLowerInvariant()] = $true }
  $added = -1
  foreach ($it in @($picked)) {
    $key = '{0}|{1}' -f [string]$it.app, ([string]$it.path).ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    [void]$script:weItems.Add([pscustomobject]@{ app = [string]$it.app; kind = [string]$it.kind; path = [string]$it.path; name = [string]$it.name })
    $added = $script:weItems.Count - 1
  }
  if ($added -ge 0) { WE-Fill $added }
}

# A dark checklist of the editor windows open right now; returns the chosen items
# (array) or $null on cancel / nothing open. Used by the manager's Add button.
function Pick-OpenWorkspaces {
  $open = @(Get-OpenWindowList)
  $script:menuOpen = $true
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text            = 'Add from open windows'
  $dlg.FormBorderStyle = 'FixedDialog'
  $dlg.StartPosition   = 'CenterScreen'
  $dlg.TopMost         = $true
  $dlg.MaximizeBox     = $false
  $dlg.MinimizeBox     = $false
  $dlg.ShowInTaskbar   = $false
  $dlg.BackColor       = $bg
  $dlg.ForeColor       = $white
  $dlg.Font            = New-Object System.Drawing.Font('Segoe UI', 9.75)
  $dlg.ClientSize      = New-Object System.Drawing.Size(520, 360)
  try { if (Test-Path $iconPath) { $dlg.Icon = New-Object System.Drawing.Icon($iconPath) } } catch {}

  $accent = Get-CDAccent
  $result = $null

  if ($open.Count -eq 0) {
    $msg = New-Object System.Windows.Forms.Label
    $msg.Text = 'No VS Code / Cursor windows are open right now.'
    $msg.AutoSize = $true; $msg.ForeColor = $grey
    $msg.Location = New-Object System.Drawing.Point(20, 24)
    $dlg.Controls.Add($msg)
  } else {
    $hint = New-Object System.Windows.Forms.Label
    $hint.Text = 'Tick the windows to add as favorites:'
    $hint.AutoSize = $true; $hint.ForeColor = $grey
    $hint.Location = New-Object System.Drawing.Point(20, 14)
    $dlg.Controls.Add($hint)

    $clb = New-Object System.Windows.Forms.CheckedListBox
    $clb.Location      = New-Object System.Drawing.Point(20, 40)
    $clb.Size          = New-Object System.Drawing.Size(480, 256)
    $clb.BackColor     = [System.Drawing.Color]::FromArgb(20, 20, 24)
    $clb.ForeColor     = $white
    $clb.BorderStyle   = 'FixedSingle'
    $clb.CheckOnClick  = $true
    $clb.IntegralHeight = $false
    $clb.Font          = New-Object System.Drawing.Font('Segoe UI', 9.75)
    foreach ($it in $open) {
      $tag = if ([string]$it.app -eq 'cursor') { 'Cursor' } else { 'Code' }
      [void]$clb.Items.Add(('[{0}]  {1}   {2}' -f $tag, [string]$it.name, [string]$it.path), $true)
    }
    $dlg.Controls.Add($clb)
  }

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'Add'; $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.FlatStyle = 'Flat'; $ok.FlatAppearance.BorderSize = 0
  $ok.ForeColor = (Get-TextOn $accent); $ok.BackColor = $accent
  $ok.Size = New-Object System.Drawing.Size(110, 32)
  $ok.Location = New-Object System.Drawing.Point(280, 312)
  $ok.Enabled = ($open.Count -gt 0)
  $dlg.Controls.Add($ok)

  $cl = New-Object System.Windows.Forms.Button
  $cl.Text = 'Cancel'; $cl.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cl.FlatStyle = 'Flat'; $cl.FlatAppearance.BorderSize = 0
  $cl.ForeColor = $grey; $cl.BackColor = $rowBg
  $cl.Size = New-Object System.Drawing.Size(110, 32)
  $cl.Location = New-Object System.Drawing.Point(390, 312)
  $dlg.Controls.Add($cl)

  $dlg.AcceptButton = $ok
  $dlg.CancelButton = $cl

  $res = $dlg.ShowDialog()
  if ($res -eq [System.Windows.Forms.DialogResult]::OK -and $open.Count -gt 0) {
    $clb = $dlg.Controls | Where-Object { $_ -is [System.Windows.Forms.CheckedListBox] } | Select-Object -First 1
    $picked = @()
    foreach ($i in $clb.CheckedIndices) { $picked += $open[$i] }
    if ($picked.Count -gt 0) { $result = $picked }
  }
  $dlg.Dispose()
  $script:menuOpen = $false
  $script:shownAt  = [Environment]::TickCount
  return $result
}

# The favorite-workspace manager (opened from the gear menu). Add (from open
# windows) / delete / reorder, then Save persists the curated list to
# workspaces.json. Same dark dialog shell as the task editor.
function Edit-Workspaces {
  $items = New-Object System.Collections.ArrayList
  foreach ($it in (Get-FavItems)) {
    [void]$items.Add([pscustomobject]@{ app = [string]$it.app; kind = [string]$it.kind; path = [string]$it.path; name = [string]$it.name })
  }

  $script:menuOpen = $true
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text            = 'Favorite workspaces'
  $dlg.FormBorderStyle = 'FixedDialog'
  $dlg.StartPosition   = 'CenterScreen'
  $dlg.TopMost         = $true
  $dlg.MaximizeBox     = $false
  $dlg.MinimizeBox     = $false
  $dlg.ShowInTaskbar   = $false
  $dlg.BackColor       = $bg
  $dlg.ForeColor       = $white
  $dlg.Font            = New-Object System.Drawing.Font('Segoe UI', 9.75)
  $dlg.ClientSize      = New-Object System.Drawing.Size(600, 412)
  try { if (Test-Path $iconPath) { $dlg.Icon = New-Object System.Drawing.Icon($iconPath) } } catch {}

  $accent = Get-CDAccent
  $script:weItems    = $items
  $script:etRowIdle  = $rowBg
  $script:etRowHov   = [System.Drawing.Color]::FromArgb(46, 46, 54)
  $script:etRowSel   = [System.Drawing.Color]::FromArgb(58, 58, 70)
  $canvasBg          = [System.Drawing.Color]::FromArgb(20, 20, 24)

  $title = New-Object System.Windows.Forms.Label
  $title.Text = 'Favorite workspaces'; $title.AutoSize = $true; $title.ForeColor = $white
  $title.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $title.Location = New-Object System.Drawing.Point(20, 13)
  $dlg.Controls.Add($title)
  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = 'reopened from the tray ' + [char]0x00B7 + ' survives a restart'
  $hint.AutoSize = $true; $hint.ForeColor = $grey
  $hint.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $dlg.Controls.Add($hint)
  $hint.Location = New-Object System.Drawing.Point((416 - $hint.PreferredWidth), 18)

  $wrap = New-Object System.Windows.Forms.Panel
  $wrap.Location  = New-Object System.Drawing.Point(20, 44)
  $wrap.Size      = New-Object System.Drawing.Size(396, 328)
  $wrap.BackColor = [System.Drawing.Color]::FromArgb(60, 60, 70)
  $dlg.Controls.Add($wrap)
  $lst = New-Object System.Windows.Forms.FlowLayoutPanel
  $lst.Location      = New-Object System.Drawing.Point(1, 1)
  $lst.Size          = New-Object System.Drawing.Size(394, 326)
  $lst.FlowDirection = 'TopDown'
  $lst.WrapContents  = $false
  $lst.AutoScroll    = $true
  $lst.BackColor     = $canvasBg
  $lst.Padding       = New-Object System.Windows.Forms.Padding(6, 6, 6, 6)
  $wrap.Controls.Add($lst)
  $script:weLst  = $lst
  $script:weRowW = $lst.ClientSize.Width - [System.Windows.Forms.SystemInformation]::VerticalScrollBarWidth - 14
  $script:weSel  = 0
  $script:weRows = @()

  $lighten = { param($c, $d) [System.Drawing.Color]::FromArgb([math]::Min(255, $c.R + $d), [math]::Min(255, $c.G + $d), [math]::Min(255, $c.B + $d)) }
  $styleBtn = {
    param($b, [string]$kind)
    $b.FlatStyle = 'Flat'
    $b.FlatAppearance.BorderSize = 0
    $b.Font   = New-Object System.Drawing.Font('Segoe UI', 9.75)
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    $b.UseVisualStyleBackColor = $false
    $b.TextAlign = 'MiddleCenter'
    if ($kind -eq 'accent')     { $base = $accent; $fore = Get-TextOn $accent }
    elseif ($kind -eq 'danger') { $base = $rowBg;  $fore = [System.Drawing.Color]::FromArgb(232, 124, 112) }
    elseif ($kind -eq 'muted')  { $base = $rowBg;  $fore = $grey }
    else                        { $base = $rowBg;  $fore = $white }
    $b.BackColor = $base; $b.ForeColor = $fore
    $b.FlatAppearance.MouseOverBackColor = (& $lighten $base 18)
    $b.FlatAppearance.MouseDownBackColor = (& $lighten $base 30)
  }
  $mkBtn = {
    param([string]$text, [int]$top, [string]$kind)
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.Size = New-Object System.Drawing.Size(150, 34)
    $b.Location = New-Object System.Drawing.Point(432, $top)
    & $styleBtn $b $kind
    $dlg.Controls.Add($b)
    return $b
  }

  $bAdd = & $mkBtn ([char]0x002B + '  Add')              44  'default'
  $bDel = & $mkBtn 'Delete'                              82  'danger'
  $bUp  = & $mkBtn ([char]0x2191 + '  Move up')          138 'default'
  $bDn  = & $mkBtn ([char]0x2193 + '  Move down')        176 'default'

  $bAdd.Add_Click({ WE-Add })
  $bDel.Add_Click({ WE-Delete })
  $bUp.Add_Click({ WE-Move -1 })
  $bDn.Add_Click({ WE-Move 1 })

  $footer = New-Object System.Windows.Forms.Label
  $footer.AutoSize = $true; $footer.ForeColor = $grey
  $footer.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $footer.Location = New-Object System.Drawing.Point(20, 388)
  $dlg.Controls.Add($footer)
  $script:weFooter = $footer

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'Save'; $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Size = New-Object System.Drawing.Size(150, 34)
  $ok.Location = New-Object System.Drawing.Point(432, 300)
  & $styleBtn $ok 'accent'
  $dlg.Controls.Add($ok)

  $cl = New-Object System.Windows.Forms.Button
  $cl.Text = 'Cancel'; $cl.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cl.Size = New-Object System.Drawing.Size(150, 34)
  $cl.Location = New-Object System.Drawing.Point(432, 338)
  & $styleBtn $cl 'muted'
  $dlg.Controls.Add($cl)

  $dlg.AcceptButton = $ok
  $dlg.CancelButton = $cl
  WE-Fill 0

  $res = $dlg.ShowDialog()
  $dlg.Dispose()
  $script:menuOpen = $false
  $script:shownAt  = [Environment]::TickCount
  if ($res -eq [System.Windows.Forms.DialogResult]::OK) { Save-FavItems $script:weItems }
}

# Material icon glyphs ($script:MAT codepoints, the private font collection, and
# New-IconFont / Get-IconChar / Set-IconLabel / New-MatIcon / New-Badge) live in
# session-ui-icons.ps1, dot-sourced above.

# Preferences (position + opacity + size) are re-read on every refresh so changes
# from the tray menu apply live without reopening the view.
$script:position   = 'top'
$script:customLeft = $null       # custom horizontal left (px); $null = centered
$script:customTop  = $null       # custom top (px); used only when position = free
$script:opacity  = 0.92          # default: light transparency (Light)
$script:widthPct = 42            # default size = Normal (% of screen width)
function Read-Prefs {
  $script:position = 'top'
  try { if (Test-Path $posFile) { $p = (Get-Content $posFile -Raw -ErrorAction Stop).Trim().ToLower(); if ($p -in @('top','bottom','free')) { $script:position = $p } } } catch {}
  $script:customLeft = $null
  try { if (Test-Path $posXFile) { $script:customLeft = [int]((Get-Content $posXFile -Raw -ErrorAction Stop).Trim()) } } catch {}
  $script:customTop = $null
  try { if (Test-Path $posYFile) { $script:customTop = [int]((Get-Content $posYFile -Raw -ErrorAction Stop).Trim()) } } catch {}
  $script:opacity = 0.92         # default: light transparency (Light)
  try { if (Test-Path $opacityFile) { $v = [int]((Get-Content $opacityFile -Raw -ErrorAction Stop).Trim()); if ($v -ge 20 -and $v -le 100) { $script:opacity = $v / 100.0 } } } catch {}
  $script:widthPct = 42          # default size = Normal
  try { if (Test-Path $sizeFile) { $w = [int]((Get-Content $sizeFile -Raw -ErrorAction Stop).Trim()); if ($w -ge 24 -and $w -le 95) { $script:widthPct = $w } } } catch {}
}

# A dragged spot (including another monitor) is remembered only while this view
# stays open. On a fresh launch we come back to the primary screen: drop the custom
# placement and clear its files. The top/bottom anchor is a real preference and is
# kept (a leftover 'free' state collapses back to the default 'top').
function Reset-LaunchPosition {
  if ($script:position -eq 'free') {
    $script:position = 'top'
    try { Set-Content -LiteralPath $posFile -Value 'top' -Encoding ASCII -ErrorAction SilentlyContinue } catch {}
  }
  $script:customLeft = $null
  $script:customTop  = $null
  try { Remove-Item -LiteralPath $posXFile -Force -ErrorAction SilentlyContinue } catch {}
  try { Remove-Item -LiteralPath $posYFile -Force -ErrorAction SilentlyContinue } catch {}
}
Read-Prefs
Reset-LaunchPosition   # fresh launch always starts on the primary screen

# --- Sizing relative to the primary screen (looks right at any resolution) ---
# The Size preference scales the WHOLE view homothetically: not just the window
# width, but fonts, badges, paddings, row + header heights — everything grows or
# shrinks together. The scale factor is $widthPct / 55 (55 is the 1.0 reference);
# the presets sit below it for a compact feel: Mini 24% -> 0.44x, Compact 30% ->
# 0.55x, Normal 42% -> 0.76x, Large 54% -> 0.98x.
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$formH  = [int]($screen.Height * 0.70)

# Recompute every size-dependent dimension from the current $widthPct. Called at
# startup and again whenever the Size preference changes live (see Refresh-List).
function Compute-Dims {
  $script:scale     = $script:widthPct / 55.0                                   # 55 = 1.0 reference
  $script:formW     = [int]($screen.Width * $script:widthPct / 100)
  $script:titlePt   = [single]([math]::Max(20, $screen.Height / 60) * $script:scale)
  $script:rowPt     = [single]([math]::Max(15, $screen.Height / 85) * $script:scale)
  $script:posPt     = [single]($script:titlePt * 0.6)
  $script:headerH   = [int]($script:titlePt * 2.6)
  $script:rowH      = [int]($script:rowPt * 3.4)
  $script:rowMargin = [int][math]::Max(4, 10 * $script:scale)
  $script:badgeSize = [int]($script:rowPt * 2.0)
  $script:statPx    = [single]([math]::Max(11, $script:rowPt * 1.25))           # status-dot glyph size (px)
  $script:statBox   = [int][math]::Ceiling($script:statPx * 1.5)                # bitmap box (matches New-MatIcon)
  $script:listPadX  = [int][math]::Max(8, 16 * $script:scale)
  $script:listPadY  = [int][math]::Max(6, 12 * $script:scale)
  $script:listPadV  = $script:listPadY * 2
  $script:grpH      = [int][math]::Max(22, $script:rowPt * 2.4)                  # per-project objective header
  $script:rowIndent = [int][math]::Max(14, 20 * $script:scale)                  # rows nest under their header
}
Compute-Dims
$script:appliedWidthPct = $script:widthPct   # tracks the size currently rendered

# The monitor the deck currently lives on. When the user has dragged a custom
# horizontal spot we resolve the screen under that point (so the deck can live on
# ANY monitor, and top/bottom anchor to THAT monitor); otherwise we default to the
# primary screen. $screen (primary) is still used as the sizing reference.
function Get-ActiveScreen {
  try {
    if ($null -ne $script:customLeft) {
      $cx = [int]$script:customLeft + [int]($script:formW / 2)
      $cy = if ($null -ne $script:customTop) { [int]$script:customTop } else { [int]$screen.Y }
      return [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point($cx, $cy))).WorkingArea
    }
  } catch {}
  return $screen
}

# Vertical placement for a window of height $h, per the chosen position, on the
# deck's current monitor. In 'free' mode (the user dragged the deck) we honour the
# saved custom top, clamped to the whole virtual desktop so it can sit on another
# monitor yet never end up fully off-screen.
function Get-FormTop($h) {
  $sc = Get-ActiveScreen
  # Collapsed, the thin strip sits FLUSH against the real screen edge (the working
  # area already excludes the taskbar); expanded, it keeps a breathing margin.
  $margin = if ($script:collapsed) { 0 } else { [int][math]::Max(24, $sc.Height * 0.04) }
  switch ($script:position) {
    'top'    { return [int]($sc.Y + $margin) }
    'bottom' { return [int]($sc.Y + $sc.Height - $h - $margin) }
    'free'   {
      $t  = if ($null -ne $script:customTop) { $script:customTop } else { [int]($sc.Y + ($sc.Height - $h) / 2) }
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      return [int][math]::Max($vs.Y, [math]::Min($t, $vs.Y + $vs.Height - $h))
    }
    default  { return [int]($sc.Y + ($sc.Height - $h) / 2) }
  }
}

# Horizontal placement for a window of width $w: the saved custom left when the
# user has dragged one (clamped to the whole virtual desktop, so another monitor
# is allowed), otherwise centered on the current monitor. Kept independently of the
# vertical position, so snapping top/bottom preserves a custom horizontal spot.
function Get-FormLeft($w) {
  if ($null -ne $script:customLeft) {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    return [int][math]::Max($vs.X, [math]::Min($script:customLeft, $vs.X + $vs.Width - $w))
  }
  $sc = Get-ActiveScreen
  return [int]($sc.X + ($sc.Width - $w) / 2)
}

$bg     = [System.Drawing.Color]::FromArgb(24, 24, 28)
$rowBg  = [System.Drawing.Color]::FromArgb(36, 36, 42)
$hover  = [System.Drawing.Color]::FromArgb(52, 52, 62)
$green  = [System.Drawing.Color]::FromArgb(80, 220, 130)
$orange = [System.Drawing.Color]::FromArgb(245, 175, 70)   # "waiting for you"
$grey   = [System.Drawing.Color]::FromArgb(150, 150, 158)
$white  = [System.Drawing.Color]::FromArgb(235, 235, 240)
$unseen = [System.Drawing.Color]::FromArgb(150, 175, 220)   # border: finished & not yet opened

# Header chrome colours. The deck normally wears a near-black header; collapsed it
# turns into a warm orange strip (so it reads as "tucked away but here"): the title
# goes white and the chrome/Pomodoro use dark, high-contrast tones that stay legible
# on the orange. $script:hdrFg / $script:hdrTitle are the LIVE resting colours the
# header's hover handlers fall back to, swapped by Set-Collapsed.
$script:headerBg    = [System.Drawing.Color]::FromArgb(18, 18, 22)
$script:collapsedBg = Get-CDAccent                                     # brand orange strip
$hdrDark            = [System.Drawing.Color]::FromArgb(40, 24, 4)       # chrome/Pomodoro icons on orange
$dimOnOrange        = [System.Drawing.Color]::FromArgb(64, 38, 16)      # muted/idle text on the orange strip
$script:hdrFg       = $grey    # resting icon colour (grey expanded, dark collapsed)
$script:hdrTitle    = Get-CDAccent  # title colour    (orange expanded, white collapsed)
$script:pomoIconRest = $grey   # Pomodoro control rest colour (grey expanded, dark on orange collapsed)

# The per-project accent colour / initials / contrasting text helpers
# (Get-ProjectColor / Get-Initials / Get-TextOn) live in session-common.ps1.

# Context occupied, compact: "117k" — empty string when unknown (old state files).
# We show raw tokens only (no %), since the model's true context window isn't reliably known.
function Format-Ctx($s) {
  $tok = $s.ctx_tokens
  if ($null -eq $tok) { return '' }
  if ([int]$tok -ge 1000) { return '{0}k' -f [int][math]::Round([int]$tok / 1000.0) }
  return [string][int]$tok
}
# Mark a session as "seen" (clears the unseen border) by writing into its state file.
function Set-Seen($sid) {
  try {
    $f = Join-Path $stateDir ($sid + '.json')
    if (Test-Path $f) {
      $o = [System.IO.File]::ReadAllText($f) | ConvertFrom-Json
      if ($o.PSObject.Properties.Name -contains 'seen') { $o.seen = $true } else { $o | Add-Member -NotePropertyName seen -NotePropertyValue $true }
      [System.IO.File]::WriteAllText($f, ($o | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    }
  } catch {}
}
# Dismiss a session from the list by stamping its CURRENT 'updated' value into a
# 'dismissed' field. The list hides the row while dismissed == updated; any new
# activity (prompt/stop/notify) rewrites 'updated' to a fresh timestamp, so the
# two no longer match and the row reappears on its own. No tracker change needed.
function Set-Dismissed($sid) {
  try {
    $f = Join-Path $stateDir ($sid + '.json')
    if (Test-Path $f) {
      $o = [System.IO.File]::ReadAllText($f) | ConvertFrom-Json
      $stamp = [string]$o.updated
      if ($o.PSObject.Properties.Name -contains 'dismissed') { $o.dismissed = $stamp } else { $o | Add-Member -NotePropertyName dismissed -NotePropertyValue $stamp }
      [System.IO.File]::WriteAllText($f, ($o | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    }
  } catch {}
}

$form = New-Object NoActivateForm
$form.FormBorderStyle = 'None'
$form.StartPosition   = 'Manual'   # pin to the PRIMARY screen (with the taskbar), not the 2nd monitor
$form.Size            = New-Object System.Drawing.Size($formW, $formH)
$formLeft = Get-FormLeft $formW
$form.Location        = New-Object System.Drawing.Point($formLeft, (Get-FormTop $formH))
$form.BackColor       = $bg
$form.Opacity         = $script:opacity
$form.TopMost         = $true
$form.ShowInTaskbar   = $true
$form.Text            = $WindowTitle
$form.KeyPreview      = $true
# Taskbar / Alt-Tab icon: the bundled logo.ico (next to this script, in the repo
# and once deployed to ~/.claude/sessions). Silently skipped if missing.
$iconPath = Join-Path $PSScriptRoot 'logo.ico'
if (Test-Path $iconPath) { try { $form.Icon = New-Object System.Drawing.Icon($iconPath) } catch {} }

# Reduce flicker: enable double buffering (protected property, set via reflection).
$dbProp = [System.Windows.Forms.Control].GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic')
$dbProp.SetValue($form, $true, $null)

# Header
$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Top'
$header.Height = $headerH
$header.BackColor = $script:headerBg
$form.Controls.Add($header)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Claude Code Sessions'
$title.ForeColor = Get-CDAccent
$title.Font = New-Object System.Drawing.Font('Segoe UI', $titlePt, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(24, [int](($headerH - $title.PreferredHeight) / 2))
$header.Controls.Add($title)

# Close button (X) — top-right corner — Material "close" glyph
$close = New-Object System.Windows.Forms.Label
Set-IconLabel $close $script:MAT.close 0x2715 ([single]($titlePt * 0.92))
$close.ForeColor = $grey
$close.AutoSize = $true
$close.Cursor = [System.Windows.Forms.Cursors]::Hand
$close.Add_MouseEnter({ $close.ForeColor = [System.Drawing.Color]::FromArgb(240, 90, 90) })
$close.Add_MouseLeave({ $close.ForeColor = $script:hdrFg })
$close.Add_Click({ $form.Close() })
$header.Controls.Add($close)

# --- Position buttons (▲ top, ▬ middle, ▼ bottom) — to the left of X ---
$posTip = New-Object System.Windows.Forms.ToolTip
function New-PosButton($matCode, $fallback, $tip) {
  $b = New-Object System.Windows.Forms.Label
  Set-IconLabel $b $matCode $fallback ([single]($posPt * 1.15))
  $b.ForeColor = $grey
  $b.AutoSize = $true
  $b.Cursor = [System.Windows.Forms.Cursors]::Hand
  $posTip.SetToolTip($b, $tip)
  $header.Controls.Add($b)
  return $b
}
$script:posTop = New-PosButton $script:MAT.top    0x25B2 'Position: top'
$script:posBot = New-PosButton $script:MAT.bottom 0x25BC 'Position: bottom'

# --- Settings gear (⚙) — opens the full menu, mirroring the tray. So every
# option is reachable straight from the on-screen deck, not just the taskbar.
$script:gear = New-Object System.Windows.Forms.Label
Set-IconLabel $script:gear $script:MAT.settings 0x2699 ([single]($posPt * 1.15))
$script:gear.ForeColor = $grey
$script:gear.AutoSize = $true
$script:gear.Cursor = [System.Windows.Forms.Cursors]::Hand
$posTip.SetToolTip($script:gear, 'Settings')
$script:gear.Add_MouseEnter({ $script:gear.ForeColor = [System.Drawing.Color]::FromArgb(120, 175, 240) })
$script:gear.Add_MouseLeave({ $script:gear.ForeColor = $script:hdrFg })
$header.Controls.Add($script:gear)

# --- Collapse toggle — shrinks the deck to just the "Claude Code Sessions" strip,
# so it can be tucked away in one click yet stay one click from coming back. The
# session list is hidden and the window height drops to the header; clicking again
# restores the auto-fit height. State is intentionally per-session (not persisted):
# a fresh popup on task completion always opens expanded.
$script:collapseBtn = New-Object System.Windows.Forms.Label
Set-IconLabel $script:collapseBtn $script:MAT.collapse 0x2303 ([single]($posPt * 1.15))
$script:collapseBtn.ForeColor = $grey
$script:collapseBtn.AutoSize = $true
$script:collapseBtn.Cursor = [System.Windows.Forms.Cursors]::Hand
$posTip.SetToolTip($script:collapseBtn, 'Collapse to a single line')
$script:collapseBtn.Add_MouseEnter({ $script:collapseBtn.ForeColor = [System.Drawing.Color]::FromArgb(120, 175, 240) })
$script:collapseBtn.Add_MouseLeave({ $script:collapseBtn.ForeColor = $script:hdrFg })
$header.Controls.Add($script:collapseBtn)

# --- Pomodoro cluster (top row) --------------------------------------------
# All Pomodoro UI lives here in the deck header. The tray runs the clock + the
# focus tracking and publishes pomodoro.json; we render it and send control
# tokens (toggle/skip/reset) via pomodoro-cmd.txt. Layout (left -> right):
#   [play/pause]  MM:SS  <phase + status>  [skip] [replay]   ...then ▲ ▼ ⚙ ✕
$blue = [System.Drawing.Color]::FromArgb(120, 175, 240)   # break accent (none defined yet in this view)

function Send-PomoCmd([string]$cmd) {
  try { Set-Content -LiteralPath $pomoCmd -Value $cmd -Encoding ASCII -ErrorAction SilentlyContinue } catch {}
}

# A clickable Material icon label for a Pomodoro control.
function New-PomoIcon($matCode, $fallback, $tip) {
  $b = New-Object System.Windows.Forms.Label
  Set-IconLabel $b $matCode $fallback ([single]($script:posPt * 1.1))
  $b.ForeColor = $grey
  $b.AutoSize = $true
  $b.Cursor = [System.Windows.Forms.Cursors]::Hand
  $posTip.SetToolTip($b, $tip)
  # Hover is always near-white (legible on both the dark header and the orange
  # strip); the resting colour follows $script:pomoIconRest, swapped by Set-Collapsed
  # (grey on the dark header, dark on the orange strip). Script-scoped vars are read
  # directly in the handler - no GetNewClosure (which would capture locals as null).
  $b.Add_MouseEnter({ $this.ForeColor = [System.Drawing.Color]::FromArgb(235, 235, 240) })
  $b.Add_MouseLeave({ $this.ForeColor = $script:pomoIconRest })
  $header.Controls.Add($b)
  return $b
}
$script:pomoToggle = New-PomoIcon $script:MAT.play  0x25B6 'Start / pause the Pomodoro'
$script:pomoSkip   = New-PomoIcon $script:MAT.skip  0x23ED 'Skip to the next phase'
$script:pomoReset  = New-PomoIcon $script:MAT.replay 0x21BA 'Reset the current timer'

$script:pomoTime = New-Object System.Windows.Forms.Label
$script:pomoTime.ForeColor = $white
$script:pomoTime.Font = New-Object System.Drawing.Font('Segoe UI', [single]($posPt * 1.05), [System.Drawing.FontStyle]::Bold)
$script:pomoTime.AutoSize = $true
$script:pomoTime.Text = '25:00'
$header.Controls.Add($script:pomoTime)

$script:pomoStatus = New-Object System.Windows.Forms.Label
$script:pomoStatus.ForeColor = $grey
$script:pomoStatus.Font = New-Object System.Drawing.Font('Segoe UI', [single]($posPt * 0.7))
$script:pomoStatus.AutoSize = $true
$script:pomoStatus.Text = 'Focus'
$header.Controls.Add($script:pomoStatus)

$script:pomoToggle.Add_Click({ Send-PomoCmd 'toggle' })
$script:pomoSkip.Add_Click({ Send-PomoCmd 'skip' })
$script:pomoReset.Add_Click({ Send-PomoCmd 'reset' })

$script:pomoCycles = 4          # mirrors the tray's $CYCLES (long break grouping)
$script:pomo = $null

# Position the cluster left-to-right, just after the title.
function Layout-Pomo {
  if (-not $script:pomoToggle) { return }
  $cy  = { param($c) [int](($script:headerH - $c.Height) / 2) }
  $gap = [int][math]::Max(8, 12 * $script:scale)
  $x   = $title.Location.X + $title.Width + [int][math]::Max(20, 26 * $script:scale)
  foreach ($c in @($script:pomoToggle, $script:pomoTime, $script:pomoStatus, $script:pomoSkip, $script:pomoReset)) {
    $c.Location = New-Object System.Drawing.Point($x, (& $cy $c))
    $x += $c.Width + $gap
  }
}

function Read-PomoState {
  $script:pomo = $null
  try { if (Test-Path $pomoState) { $script:pomo = [System.IO.File]::ReadAllText($pomoState) | ConvertFrom-Json } } catch {}
}

function Render-Pomo {
  $o = $script:pomo
  $running = $false; $remaining = ($script:pomoCycles * 0) + 1500; $track = 'paused'; $status = 'Ready'; $completed = 0
  if ($o) {
    $running   = [bool]$o.running
    $remaining = [int]$o.remaining
    $track     = [string]$o.track
    $status    = [string]$o.status
    $completed = [int]$o.completed
  }
  $mm = [int][math]::Floor($remaining / 60); $ss = [int]($remaining % 60)
  # On the orange strip everything must read against the warm background: white when
  # the clock runs (pops like the title), a muted dark when idle. On the dark header
  # it keeps the usual white/grey.
  $onOrange = $script:collapsed
  $script:pomoTime.Text = ('{0:00}:{1:00}' -f $mm, $ss)
  $script:pomoTime.ForeColor = if ($running) { $white } elseif ($onOrange) { $dimOnOrange } else { $grey }

  # Play when paused, pause when running.
  if ($running) { $script:pomoToggle.Text = Get-IconChar $script:MAT.pause 0x23F8 }
  else          { $script:pomoToggle.Text = Get-IconChar $script:MAT.play  0x25B6 }

  # Cycle dots toward the long break.
  $done = $completed % $script:pomoCycles
  $dots = ''
  for ($i = 0; $i -lt $script:pomoCycles; $i++) { $dots += if ($i -lt $done) { [char]0x25CF } else { [char]0x25CB } }
  if (-not $status) { $status = 'Ready' }
  if ($status.Length -gt 26) { $status = $status.Substring(0, 26) + [char]0x2026 }
  $script:pomoStatus.Text = ('{0}   {1}' -f $status, $dots)
  # The expanded track palette (green/orange/blue) would vanish on the orange strip -
  # orange-on-orange especially - so collapsed uses dark, distinct variants instead.
  $script:pomoStatus.ForeColor = if ($onOrange) {
    switch ($track) {
      'work'     { [System.Drawing.Color]::FromArgb(20, 78, 42) }
      'distract' { [System.Drawing.Color]::FromArgb(120, 22, 22) }
      'break'    { [System.Drawing.Color]::FromArgb(22, 50, 110) }
      default    { $dimOnOrange }
    }
  } else {
    switch ($track) { 'work' { $green } 'distract' { $orange } 'break' { $blue } default { $grey } }
  }

  Layout-Pomo

  # While collapsed, the Pomodoro cluster can appear/disappear on its own (the tray
  # owns the clock), so keep its visibility and the strip width in sync with it.
  if ($script:collapsed) {
    Apply-PomoVisibility
    $active = Test-PomoActive
    if ($active -ne $script:collapsedActivePomo) {
      $script:collapsedActivePomo = $active
      $form.Width = Get-CollapsedWidth
      if (-not $script:dragging) { $form.Left = Get-FormLeft $form.Width }
      Layout-Header
    }
  }
}

# Blink the status when off track (pulse, never spin - a ClaudeDeck convention).
$script:pomoPulseOn = $false
$pomoPulse = New-Object System.Windows.Forms.Timer
$pomoPulse.Interval = 550
$pomoPulse.Add_Tick({
  if ($script:pomo -and [bool]$script:pomo.running -and ([string]$script:pomo.track -eq 'distract')) {
    $script:pomoPulseOn = -not $script:pomoPulseOn
    # On the orange strip an orange blink would be invisible - blink dark-red <-> white
    # so the nag still reads; on the dark header keep the usual orange <-> white.
    if ($script:collapsed) {
      $script:pomoStatus.ForeColor = if ($script:pomoPulseOn) { [System.Drawing.Color]::FromArgb(120, 22, 22) } else { $white }
    } else {
      $script:pomoStatus.ForeColor = if ($script:pomoPulseOn) { $orange } else { $white }
    }
  }
})
$pomoPulse.Start()

# The settings menu (rebuilt on every open so checkmarks reflect current state).
$script:settingsMenu = New-Object System.Windows.Forms.ContextMenuStrip
$script:menuOpen = $false
$script:settingsMenu.Add_Opening({ $script:menuOpen = $true })   # suppress click-outside-close while open
$script:settingsMenu.Add_Closed({ $script:menuOpen = $false; $script:shownAt = [Environment]::TickCount })

function Build-SettingsMenu {
  $m = $script:settingsMenu
  $m.Items.Clear()

  # Prominent "install update" entry, shown only when a newer version was found.
  $upd = Get-UpdateInfo
  if ($upd) {
    $ui = New-Object System.Windows.Forms.ToolStripMenuItem(("Install update (v{0})" -f $upd.latest))
    $ui.ForeColor = [System.Drawing.Color]::FromArgb(80, 160, 90)
    $ui.ToolTipText = "Downloads the latest GitHub release and installs it; the deck restarts automatically (the tray reports the result)"
    $ui.Add_Click({ Invoke-Updater '-Apply' })
    [void]$m.Items.Add($ui)
    [void]$m.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  }

  $dnd = New-Object System.Windows.Forms.ToolStripMenuItem('Do not disturb')
  $dnd.Checked = (Test-Path $dndFlag)
  $dnd.ToolTipText = "Suspends the auto-popup of the large view on task completion"
  $dnd.Add_Click({ Toggle-Flag $dndFlag })
  [void]$m.Items.Add($dnd)

  $co = New-Object System.Windows.Forms.ToolStripMenuItem('Close on outside click')
  $co.Checked = (Test-Path $closeFlag)
  $co.ToolTipText = "Close this view when clicking outside it (off by default)"
  $co.Add_Click({ Toggle-Flag $closeFlag })
  [void]$m.Items.Add($co)

  $fn = New-Object System.Windows.Forms.ToolStripMenuItem('Focus nudge')
  $fn.Checked = (-not (Test-Path $focusOffFlag))
  $fn.ToolTipText = "When no session is running and you drift to a distracting app, Claude nudges you back with a sound + popup and keeps it up until you refocus a real app (on by default)"
  $fn.Add_Click({ Toggle-Flag $focusOffFlag })
  [void]$m.Items.Add($fn)

  # Transparency submenu — writes opacity % (re-read live on the next refresh).
  $curOp = [int]([math]::Round($script:opacity * 100))
  $opMenu = New-Object System.Windows.Forms.ToolStripMenuItem('Transparency')
  $opMenu.ToolTipText = "Make this view more or less transparent"
  foreach ($lvl in @(
      @{ v = 100; l = 'None (opaque)' },
      @{ v = 92;  l = 'Light' },
      @{ v = 80;  l = 'Medium' },
      @{ v = 65;  l = 'Strong' })) {
    $mi = New-Object System.Windows.Forms.ToolStripMenuItem($lvl.l)
    $mi.Checked = ($curOp -eq $lvl.v)
    $val = $lvl.v
    $mi.Add_Click({ Set-Content -LiteralPath $opacityFile -Value $val -Encoding ASCII -ErrorAction SilentlyContinue }.GetNewClosure())
    [void]$opMenu.DropDownItems.Add($mi)
  }
  [void]$m.Items.Add($opMenu)

  # Size submenu — writes a size value (the view rescales the WHOLE layout live).
  $curSize = $script:widthPct
  $szMenu = New-Object System.Windows.Forms.ToolStripMenuItem('Size')
  $szMenu.ToolTipText = "Overall size of this view (scales everything together)"
  foreach ($sz in @(
      @{ v = 24; l = 'Mini' },
      @{ v = 30; l = 'Compact' },
      @{ v = 42; l = 'Normal' },
      @{ v = 54; l = 'Large' })) {
    $mi = New-Object System.Windows.Forms.ToolStripMenuItem($sz.l)
    $mi.Checked = ($curSize -eq $sz.v)
    $val = $sz.v
    $mi.Add_Click({ Set-Content -LiteralPath $sizeFile -Value $val -Encoding ASCII -ErrorAction SilentlyContinue }.GetNewClosure())
    [void]$szMenu.DropDownItems.Add($mi)
  }
  [void]$m.Items.Add($szMenu)

  [void]$m.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  # Favorite workspaces - a curated, manually-managed list (workspaces.json).
  # "Manage favorites" opens the add/delete/reorder editor (Add picks from the
  # editor windows open right now); a workspace can also be added straight from a
  # session row's right-click menu. "Reopen" relaunches them (survives a Windows
  # restart) - a submenu: "Reopen all" plus one entry per saved workspace.
  $wsItems = Get-FavItems
  $wsN = @($wsItems).Count

  $wsMng = New-Object System.Windows.Forms.ToolStripMenuItem('Manage favorite workspaces' + [char]0x2026)
  $wsMng.ToolTipText = "Add (from open editor windows) or remove the workspaces saved as favorites"
  $wsMng.Add_Click({ Edit-Workspaces })
  [void]$m.Items.Add($wsMng)

  $wsReTxt = if ($wsN -gt 0) { "Reopen favorite workspaces ($wsN)" } else { 'Reopen favorite workspaces' }
  $wsRe = New-Object System.Windows.Forms.ToolStripMenuItem($wsReTxt)
  $wsRe.ToolTipText = "Relaunch the workspaces saved as favorites"
  $wsRe.Enabled = ($wsN -gt 0)
  if ($wsN -gt 0) {
    $wsAll = New-Object System.Windows.Forms.ToolStripMenuItem(("Reopen all ({0})" -f $wsN))
    $wsAll.ToolTipText = "Relaunch every saved workspace in one click"
    $wsAll.Add_Click({ Invoke-Workspaces '-Restore' })
    [void]$wsRe.DropDownItems.Add($wsAll)
    [void]$wsRe.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    foreach ($it in $wsItems) {
      $p = [string]$it.path
      if (-not $p) { continue }
      $name = [string]$it.name; if (-not $name) { $name = $p }
      $mi = New-Object System.Windows.Forms.ToolStripMenuItem($name)
      $mi.ToolTipText = ('{0}  [{1}]' -f $p, [string]$it.app)
      $mi.Add_Click({ Invoke-Workspaces '-Restore' $p }.GetNewClosure())
      [void]$wsRe.DropDownItems.Add($mi)
    }
  }
  [void]$m.Items.Add($wsRe)

  [void]$m.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  # Auto-update toggle (opt-in / off by default) + manual check.
  $au = New-Object System.Windows.Forms.ToolStripMenuItem('Automatic updates')
  $au.Checked = (Test-Path $autoUpdFlag)
  $au.ToolTipText = "Periodically checks GitHub and installs new versions automatically (the deck restarts on its own)"
  $au.Add_Click({
    if (Test-Path $autoUpdFlag) { Remove-Item $autoUpdFlag -Force -ErrorAction SilentlyContinue }
    else { Set-Content -LiteralPath $autoUpdFlag -Value '' -Encoding ASCII; Invoke-Updater '-Check' }
  })
  [void]$m.Items.Add($au)

  $chk = New-Object System.Windows.Forms.ToolStripMenuItem('Check for updates')
  $chk.ToolTipText = "Check GitHub for a new version now"
  $chk.Add_Click({ Invoke-Updater '-Check' })
  [void]$m.Items.Add($chk)

  $ver = Get-LocalVersion
  if ($ver) {
    $vi = New-Object System.Windows.Forms.ToolStripMenuItem("ClaudeDeck v$ver")
    $vi.Enabled = $false
    [void]$m.Items.Add($vi)
  }

  [void]$m.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $stats = New-Object System.Windows.Forms.ToolStripMenuItem('Show statistics')
  $stats.ToolTipText = "Open the statistics dashboard (activity, focus time, top projects)"
  $stats.Add_Click({ Start-Process wscript.exe -ArgumentList ('"{0}"' -f $statsVbs) -ErrorAction SilentlyContinue })
  [void]$m.Items.Add($stats)

  $recap = New-Object System.Windows.Forms.ToolStripMenuItem('Generate weekly recap now')
  $recap.ToolTipText = "Summarize this week's work per project right now (also auto-opens every Friday at 17:00)"
  $recap.Add_Click({ Start-Process wscript.exe -ArgumentList ('"{0}"' -f $recapVbs) -ErrorAction SilentlyContinue })
  [void]$m.Items.Add($recap)

  # Cloud sync: mirror the todos + activity history to a folder kept in sync across
  # PCs (Google Drive / OneDrive / Synology Drive). Picking a folder enables it and
  # seeds it from the current local todos; the tick shows it's on. Other PCs point at
  # the same folder to share the data. See Get-CDSyncDir / Set-CDSyncDir.
  $sync = New-Object System.Windows.Forms.ToolStripMenuItem('Cloud sync folder...')
  $curSync = Get-CDSyncDir
  $sync.Checked = [bool]$curSync
  $sync.ToolTipText = if ($curSync) {
    "Todos + activity history sync via:`n$curSync`nClick to change the folder."
  } else {
    "Mirror your todos and activity history to a folder synced across PCs (Google Drive / OneDrive / Synology) so they follow you between machines"
  }
  $sync.Add_Click({
    $script:menuOpen = $true
    try {
      $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
      $dlg.Description = 'Pick a folder synced across your PCs (Google Drive / OneDrive / Synology Drive). Your todos and activity history will live there.'
      $c = Get-CDSyncDir
      if ($c) { $dlg.SelectedPath = $c }
      if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        Set-CDSyncDir $dlg.SelectedPath
        Read-Objectives
        Invalidate-List
      }
      $dlg.Dispose()
    } catch {}
    $script:menuOpen = $false
    $script:shownAt  = [Environment]::TickCount
  })
  [void]$m.Items.Add($sync)

  $setup = New-Object System.Windows.Forms.ToolStripMenuItem('Setup / configuration...')
  $setup.ToolTipText = "Open the setup panel (recap LLM, cloud sync folder, updates, focus)"
  $setup.Add_Click({ Start-Process wscript.exe -ArgumentList ('"{0}"' -f $onbVbs) -ErrorAction SilentlyContinue })
  [void]$m.Items.Add($setup)

  $envEdit = New-Object System.Windows.Forms.ToolStripMenuItem('Edit recap settings (.env)')
  $envEdit.ToolTipText = "Open the .env file (LLM provider, server URL, model, API key) in Notepad"
  $envEdit.Add_Click({
    $envPath = Join-Path $env:USERPROFILE '.claude\sessions\.env'
    $tmpl    = Join-Path $env:USERPROFILE '.claude\sessions\.env.example'
    if (-not (Test-Path $envPath) -and (Test-Path $tmpl)) { Copy-Item $tmpl $envPath -Force -ErrorAction SilentlyContinue }
    Start-Process notepad.exe ('"{0}"' -f $envPath) -ErrorAction SilentlyContinue
  })
  [void]$m.Items.Add($envEdit)

  $hide = New-Object System.Windows.Forms.ToolStripMenuItem('Hide this view')
  $hide.ToolTipText = "Close the view (the tray keeps running; reopen with Win+Alt+C)"
  $hide.Add_Click({ $form.Close() })
  [void]$m.Items.Add($hide)

  $quit = New-Object System.Windows.Forms.ToolStripMenuItem('Quit ClaudeDeck')
  $quit.ToolTipText = "Close the view AND stop the tray (quits ClaudeDeck entirely)"
  $quit.Add_Click({
    # Stop the tray process, then close this view.
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*session-tray.ps1*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $form.Close()
  })
  [void]$m.Items.Add($quit)
}

$script:gear.Add_Click({
  Build-SettingsMenu
  $script:settingsMenu.Show($script:gear, (New-Object System.Drawing.Point(0, $script:gear.Height)))
})

# Collapse / expand the deck to its header strip. When collapsed the deck becomes a
# thin ORANGE bar: the width shrinks to just fit the title + header buttons, the
# list is hidden, the Pomodoro cluster is hidden unless a timer is actually running,
# and the window is pinned to the header height. Refresh-List skips its auto-fit
# while collapsed so a background refresh can't grow it back. Expanding restores
# everything (full width, dark header, list, fit-to-rows height).
$script:collapsed = $false
$script:collapsedActivePomo = $false
# Collapsed-strip "heartbeat": while collapsed AND at least one session is active
# (running or waiting), the orange header pulses smoothly toward black so the tucked-
# away strip still signals "work is happening". Driven by $collapsePulse (defined with
# the other timers); $script:activeCount is refreshed by Refresh-List.
$script:headerPulseOn = $false
$script:activeCount   = 0

# True while a Pomodoro timer is actually running — the only state worth keeping
# on-screen when collapsed.
function Test-PomoActive { return ($script:pomo -and [bool]$script:pomo.running) }

# Show the Pomodoro cluster always when expanded; collapsed only when a timer runs.
function Apply-PomoVisibility {
  $show = (-not $script:collapsed) -or (Test-PomoActive)
  foreach ($c in @($script:pomoToggle, $script:pomoTime, $script:pomoStatus, $script:pomoSkip, $script:pomoReset)) {
    if ($c.Visible -ne $show) { $c.Visible = $show }
  }
}

# Minimal width that still fits the title, the right-hand button cluster, and the
# Pomodoro cluster when it's on screen. Mirrors the gaps used by Layout-Header /
# Layout-Pomo so the title and buttons just clear each other.
function Get-CollapsedWidth {
  $rightSpan = 20 + $close.Width + 18 + $script:gear.Width + 18 + $script:posBot.Width +
               10 + $script:posTop.Width + 18 + $script:collapseBtn.Width + 24 + $hint.Width
  $w = 24 + $title.Width + 30 + $rightSpan
  if (Test-PomoActive) {
    $gap  = [int][math]::Max(8, 12 * $script:scale)
    $lead = [int][math]::Max(20, 26 * $script:scale)
    $pw   = $lead
    foreach ($c in @($script:pomoToggle, $script:pomoTime, $script:pomoStatus, $script:pomoSkip, $script:pomoReset)) { $pw += $c.Width + $gap }
    $w += $pw
  }
  return [int]$w
}

# Snap the deck's vertical anchor to whichever screen edge (top / bottom) its current
# position is closest to, and persist it like the position buttons do. Called when
# collapsing so the thin strip tucks itself against the nearest edge instead of
# hovering wherever the expanded deck happened to sit (a 'free' vertical spot, or the
# previously chosen edge). The custom HORIZONTAL spot is untouched — Get-FormLeft still
# honours $customLeft — so the strip keeps its column and only snaps up/down.
function Set-NearestEdge {
  $sc     = Get-ActiveScreen
  $topGap = $form.Top - $sc.Y
  $botGap = ($sc.Y + $sc.Height) - ($form.Top + $form.Height)
  $edge   = if ($topGap -le $botGap) { 'top' } else { 'bottom' }
  $script:position = $edge
  try { Set-Content -LiteralPath $posFile -Value $edge -Encoding ASCII -ErrorAction SilentlyContinue } catch {}
  Update-PosHighlight
}

function Set-Collapsed([bool]$c) {
  $script:collapsed = $c
  $list.Visible = -not $c
  # (if ...) can't be used as a command argument on PS 5.1 — compute first.
  $icoCode = if ($c) { $script:MAT.expand } else { $script:MAT.collapse }
  $icoFb   = if ($c) { 0x2304 } else { 0x2303 }
  $icoTip  = if ($c) { 'Expand the deck' } else { 'Collapse to a single line' }
  Set-IconLabel $script:collapseBtn $icoCode $icoFb ([single]($script:posPt * 1.15))
  $posTip.SetToolTip($script:collapseBtn, $icoTip)

  # Header chrome: collapsed = orange strip with a WHITE title and dark chrome/Pomodoro
  # icons (legible on orange); expanded = dark header with the orange brand title and
  # grey chrome. Re-apply the resting colours so the hover handlers and the position
  # highlight fall back to the right palette.
  if ($c) {
    $header.BackColor    = $script:collapsedBg
    $script:hdrFg        = $hdrDark
    $script:hdrTitle     = $white      # white title on the orange strip
    $script:pomoIconRest = $hdrDark    # dark Pomodoro controls on the orange strip
  } else {
    $header.BackColor    = $script:headerBg
    $script:hdrFg        = $grey
    $script:hdrTitle     = Get-CDAccent   # brand orange title on the dark header
    $script:pomoIconRest = $grey
  }
  $title.ForeColor              = $script:hdrTitle
  $close.ForeColor              = $script:hdrFg
  $script:gear.ForeColor        = $script:hdrFg
  $script:collapseBtn.ForeColor = $script:hdrFg
  foreach ($c2 in @($script:pomoToggle, $script:pomoSkip, $script:pomoReset)) { $c2.ForeColor = $script:pomoIconRest }
  Update-PosHighlight

  Apply-PomoVisibility
  $script:collapsedActivePomo = Test-PomoActive

  if ($c) {
    # Snap to the nearest edge BEFORE resizing, while the form still has its expanded
    # geometry — that's the spot the user is judging "top vs bottom" against.
    if (-not $script:dragging) { Set-NearestEdge }
    $form.Height = $script:headerH
    $form.Width  = Get-CollapsedWidth
    if (-not $script:dragging) {
      $form.Left = Get-FormLeft $form.Width
      $form.Top  = Get-FormTop $form.Height
    }
    Layout-Header
  } else {
    $form.Width = $script:formW
    if (-not $script:dragging) { $form.Left = Get-FormLeft $script:formW }
    Layout-Header
    $script:lastSig = $null   # force a rebuild + auto-fit on the next refresh
    Refresh-List
  }
  Update-CollapsePulse
}
# The button is a Label, which fires TWO Click events for a double-click (Labels don't
# coalesce into DoubleClick). Without this guard, double-clicking the button toggles
# twice -> net nothing: collapsing via the button left the cursor on it, so a user's
# "double-click to reopen" re-collapsed instantly. Swallow the second click within the
# system double-click window so a double-click counts as a single toggle.
$script:lastCollapseToggle = [Environment]::TickCount - 100000
$script:collapseBtn.Add_Click({
  $now = [Environment]::TickCount
  if (($now - $script:lastCollapseToggle) -lt [System.Windows.Forms.SystemInformation]::DoubleClickTime) { return }
  $script:lastCollapseToggle = $now
  Set-Collapsed (-not $script:collapsed)
})

# Start/stop the collapsed-strip heartbeat to match the current state: pulse only
# while collapsed with an active session. When it shouldn't run, restore the flat
# orange resting colour (so a stopped pulse never freezes mid-fade).
function Update-CollapsePulse {
  $want = ($script:collapsed -and ($script:activeCount -gt 0))
  if ($want) {
    if (-not $script:headerPulseOn) { $script:headerPulseOn = $true; $collapsePulse.Start() }
  } else {
    if ($script:headerPulseOn) { $script:headerPulseOn = $false; $collapsePulse.Stop() }
    if ($script:collapsed) { $header.BackColor = $script:collapsedBg }
  }
}

# Highlight the active position; the others stay dim.
function Update-PosHighlight {
  $act = $script:hdrTitle   # orange brand title expanded, white when collapsed (on orange)
  $idl = $script:hdrFg
  $script:posTop.ForeColor = if ($script:position -eq 'top')    { $act } else { $idl }
  $script:posBot.ForeColor = if ($script:position -eq 'bottom') { $act } else { $idl }
}
function Set-Position($pos) {
  try { Set-Content -LiteralPath $posFile -Value $pos -Encoding ASCII -ErrorAction SilentlyContinue } catch {}
  $script:position = $pos
  $form.Top = Get-FormTop $form.Height
  Update-PosHighlight
}
$script:posTop.Add_Click({ Set-Position 'top' })
$script:posBot.Add_Click({ Set-Position 'bottom' })
foreach ($pb in @($script:posTop, $script:posBot)) {
  $pb.Add_MouseEnter({ $this.ForeColor = [System.Drawing.Color]::FromArgb(120, 175, 240) }.GetNewClosure())
  $pb.Add_MouseLeave({ Update-PosHighlight }.GetNewClosure())
}
Update-PosHighlight

# --- Drag the deck anywhere on screen --------------------------------------
# Click-and-drag on empty header space (or the title) moves the whole window.
# On release we persist the new spot: posx.txt always (the custom horizontal,
# kept even when you later snap top/bottom) and posy.txt + position='free' for
# the vertical (overridden the moment you click the top/bottom buttons). The
# refresh timer skips repositioning while a drag is in progress (see Refresh-List).
$script:dragging   = $false
$script:dragMoved  = $false   # true once the cursor travelled past the click threshold
$script:dragOrigin = $null    # cursor screen position when the drag began
$script:dragStart  = $null    # window location when the drag began
$header.Cursor = [System.Windows.Forms.Cursors]::SizeAll

# Drag "ghost" for the collapsed strip. Because the real strip is vertically locked to
# an edge (it only flips at the screen midpoint), a vertical drag would otherwise look
# like nothing happens — the user wouldn't guess they can move it to the other side. So
# while dragging collapsed we show a translucent copy that follows the cursor FREELY
# (vertical included); the solid strip then jumps to meet it once the midpoint is
# crossed. Lazily created on first use, hidden otherwise. NoActivateForm so it never
# steals focus.
$script:ghost = $null
function Get-Ghost {
  if ($null -eq $script:ghost) {
    $g = New-Object NoActivateForm
    $g.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $g.ShowInTaskbar   = $false
    $g.TopMost         = $true
    $g.StartPosition   = [System.Windows.Forms.FormStartPosition]::Manual
    $g.BackColor       = $script:collapsedBg
    $g.Opacity         = 0.42
    $script:ghost = $g
  }
  return $script:ghost
}
function Hide-Ghost { if ($null -ne $script:ghost -and $script:ghost.Visible) { $script:ghost.Hide() } }
function Save-CustomPosition {
  $script:customLeft = $form.Left
  $script:customTop  = $form.Top
  $script:position   = 'free'
  try {
    Set-Content -LiteralPath $posXFile -Value $form.Left -Encoding ASCII -ErrorAction SilentlyContinue
    Set-Content -LiteralPath $posYFile -Value $form.Top  -Encoding ASCII -ErrorAction SilentlyContinue
    Set-Content -LiteralPath $posFile  -Value 'free'     -Encoding ASCII -ErrorAction SilentlyContinue
  } catch {}
  Update-PosHighlight
}
function Start-Drag {
  $script:dragging   = $true
  $script:dragMoved  = $false
  $script:dragOrigin = [System.Windows.Forms.Cursor]::Position
  $script:dragStart  = $form.Location
}
function Do-Drag {
  if (-not $script:dragging) { return }
  $cur = [System.Windows.Forms.Cursor]::Position
  # Arm the drag only past a small real travel. Windows posts synthetic
  # WM_MOUSEMOVEs with NO motion (notably right after a menu closes), and a
  # sub-pixel wiggle during a plain click must not pop the ghost: a TopMost
  # window appearing under the cursor mid-click makes WinForms swallow the
  # control's Click/DoubleClick (the WindowFromPoint gate in WmMouseUp).
  if (-not $script:dragMoved) {
    if (([math]::Abs($cur.X - $script:dragOrigin.X) -lt 4) -and ([math]::Abs($cur.Y - $script:dragOrigin.Y) -lt 4)) { return }
    $script:dragMoved = $true
  }
  $nx  = $script:dragStart.X + ($cur.X - $script:dragOrigin.X)
  if ($script:collapsed) {
    # Collapsed, the strip can't float vertically: it stays glued to an edge and only
    # flips to the other once its centre crosses the screen's vertical midpoint. The
    # horizontal still follows the cursor freely. Screen.FromPoint keeps this correct
    # across monitors. The edge is FLUSH (working area already excludes the taskbar).
    $sc  = [System.Windows.Forms.Screen]::FromPoint($cur).WorkingArea
    $ny0 = $script:dragStart.Y + ($cur.Y - $script:dragOrigin.Y)
    $ny  = if (($ny0 + $form.Height / 2) -lt ($sc.Y + $sc.Height / 2)) { $sc.Y }
           else { $sc.Y + $sc.Height - $form.Height }
    $form.Location = New-Object System.Drawing.Point([int]$nx, [int]$ny)
    # Ghost trails the cursor's true (un-snapped) vertical so the move reads as possible.
    $g = Get-Ghost
    if ($g.Size -ne $form.Size) { $g.Size = $form.Size }
    $g.Location = New-Object System.Drawing.Point([int]$nx, [int]$ny0)
    if (-not $g.Visible) { $g.Show() }
    return
  }
  $ny  = $script:dragStart.Y + ($cur.Y - $script:dragOrigin.Y)
  $form.Location = New-Object System.Drawing.Point([int]$nx, [int]$ny)
}
function End-Drag {
  if (-not $script:dragging) { return }
  $script:dragging = $false
  Hide-Ghost
  # Only persist if it actually moved — a bare click shouldn't switch to 'free'.
  $moved = ([math]::Abs($form.Left - $script:dragStart.X) -gt 3) -or ([math]::Abs($form.Top - $script:dragStart.Y) -gt 3)
  if (-not $moved) { return }
  if ($script:collapsed) {
    # Keep the new column (custom horizontal) but record the snapped edge as the real
    # position (top/bottom), NOT 'free' — so the strip stays flush and an expand later
    # honours that edge. The form is already snapped, so Set-NearestEdge reads it right.
    $script:customLeft = $form.Left
    try { Set-Content -LiteralPath $posXFile -Value $form.Left -Encoding ASCII -ErrorAction SilentlyContinue } catch {}
    Set-NearestEdge
    return
  }
  Save-CustomPosition
}
# The passive Pomodoro labels (clock + status) join the drag/double-click surfaces:
# while a timer runs they occupy most of the collapsed strip, and without handlers a
# double-click landing on them silently did nothing — "double-click to expand" only
# worked on the title or the gaps. (The pomo ICON buttons keep their own Click actions.)
foreach ($dragSurface in @($header, $title, $script:pomoTime, $script:pomoStatus)) {
  # Double-click on the header/title folds/unfolds the deck — same toggle as the
  # ▲/▼ button. Detected on the SECOND MouseDown (e.Clicks = 2), NOT via the
  # MouseDoubleClick event: WinForms only raises Click/DoubleClick when the window
  # under the cursor at mouse-UP is the control itself (WindowFromPoint gate), so
  # anything sliding under the cursor mid-click — the drag ghost, fallout from a
  # just-closed menu — silently ate the event ("double-click doesn't always work").
  # e.Clicks on MouseDown is the raw Win32 WM_LBUTTONDBLCLK and always arrives.
  $dragSurface.Add_MouseDown({ param($snd, $e)
    if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
    if ($e.Clicks -ge 2) {
      $script:dragging = $false; Hide-Ghost
      Set-Collapsed (-not $script:collapsed)
    } else { Start-Drag }
  })
  $dragSurface.Add_MouseMove({ param($snd, $e) Do-Drag })
  $dragSurface.Add_MouseUp({   param($snd, $e) End-Drag })
}

$hint = New-Object System.Windows.Forms.Label
$hint.Text = ''
$hint.ForeColor = $grey
$hint.Font = New-Object System.Drawing.Font('Segoe UI', [single]($rowPt * 0.7))
$hint.AutoSize = $true
$header.Controls.Add($hint)

# Keep X, the gear, the collapse toggle, the position buttons and the hint pinned
# to the right edge.  Layout from the right:  [hint]  ⊟   ▲ ▼   ⚙   ✕
function Layout-Header {
  $cy = { param($c) [int](($script:headerH - $c.Height) / 2) }
  $x  = $header.Width - 20
  $x -= $close.Width;                       $close.Location             = New-Object System.Drawing.Point($x, (& $cy $close))
  $x -= ($script:gear.Width + 18);          $script:gear.Location       = New-Object System.Drawing.Point($x, (& $cy $script:gear))
  $x -= ($script:posBot.Width + 18);        $script:posBot.Location     = New-Object System.Drawing.Point($x, (& $cy $script:posBot))
  $x -= ($script:posTop.Width + 10);        $script:posTop.Location     = New-Object System.Drawing.Point($x, (& $cy $script:posTop))
  $x -= ($script:collapseBtn.Width + 18);   $script:collapseBtn.Location = New-Object System.Drawing.Point($x, (& $cy $script:collapseBtn))
  $x -= ($hint.Width + 24);                 $hint.Location              = New-Object System.Drawing.Point($x, (& $cy $hint))
  Layout-Pomo
}
$header.Add_Resize({ Layout-Header })

# Re-apply the current scale to every header control (fonts + heights). Called
# when the Size preference changes live so text grows/shrinks with the window.
function Restyle {
  $header.Height  = $script:headerH
  $title.Font     = New-Object System.Drawing.Font('Segoe UI', $script:titlePt, [System.Drawing.FontStyle]::Bold)
  $title.Location = New-Object System.Drawing.Point(24, [int](($script:headerH - $title.PreferredHeight) / 2))
  $close.Font     = New-IconFont ([single]($script:titlePt * 0.92))
  foreach ($pb in @($script:posTop, $script:posBot)) {
    $pb.Font = New-IconFont ([single]($script:posPt * 1.15))
  }
  $script:gear.Font = New-IconFont ([single]($script:posPt * 1.15))
  $script:collapseBtn.Font = New-IconFont ([single]($script:posPt * 1.15))
  $cCode = if ($script:collapsed) { $script:MAT.expand } else { $script:MAT.collapse }
  $cFb   = if ($script:collapsed) { 0x2304 } else { 0x2303 }
  $script:collapseBtn.Text = Get-IconChar $cCode $cFb
  foreach ($c in @($script:pomoToggle, $script:pomoSkip, $script:pomoReset)) { $c.Font = New-IconFont ([single]($script:posPt * 1.1)) }
  $script:pomoToggle.Text = Get-IconChar $script:MAT.play  0x25B6   # re-set so the glyph survives the re-font
  $script:pomoSkip.Text   = Get-IconChar $script:MAT.skip  0x23ED
  $script:pomoReset.Text  = Get-IconChar $script:MAT.replay 0x21BA
  $script:pomoTime.Font   = New-Object System.Drawing.Font('Segoe UI', [single]($script:posPt * 1.05), [System.Drawing.FontStyle]::Bold)
  $script:pomoStatus.Font = New-Object System.Drawing.Font('Segoe UI', [single]($script:posPt * 0.7))
  $hint.Font    = New-Object System.Drawing.Font('Segoe UI', [single]($script:rowPt * 0.7))
  $list.Padding = New-Object System.Windows.Forms.Padding($script:listPadX, $script:listPadY, $script:listPadX, $script:listPadY)
  Layout-Header
}

# Scrollable list
$list = New-Object System.Windows.Forms.FlowLayoutPanel
$list.Dock = 'Fill'
$list.FlowDirection = 'TopDown'
$list.WrapContents = $false
$list.AutoScroll = $true
$list.BackColor = $bg
$list.Padding = New-Object System.Windows.Forms.Padding($script:listPadX, $script:listPadY, $script:listPadX, $script:listPadY)
$dbProp.SetValue($list, $true, $null)   # double-buffer the list too
$form.Controls.Add($list)
$list.BringToFront()

# --- Mouse-wheel todo cycling ----------------------------------------------
# The overlay is WS_EX_NOACTIVATE and never takes focus, so neither the form nor its
# children reliably raise the .NET MouseWheel event. We capture WM_MOUSEWHEEL app-wide
# via [WheelFilter] (session-ui-interop.ps1): when the cursor is over a project's todo
# header we cycle that project's task IN PLACE (no rebuild) and consume the scroll;
# anywhere else we return $false so the session list scrolls natively. The x/y handed
# in are SCREEN coordinates (the WM_MOUSEWHEEL convention), ready for hit-testing.
[WheelFilter]::Handler = [Func[int, int, int, bool]] {
  param([int]$x, [int]$y, [int]$delta)
  try {
    # A modal dialog (task editor / input) is open over the deck: let it scroll natively.
    if ($script:menuOpen) { return $false }
    $pt = New-Object System.Drawing.Point($x, $y)
    foreach ($h in $script:objHeaders) {
      $panel = $h.panel
      if (-not $panel -or $panel.IsDisposed) { continue }
      $rect = $panel.RectangleToScreen($panel.ClientRectangle)
      if (-not $rect.Contains($pt)) { continue }
      $n = @(Get-OpenTasks $h.project).Count
      if ($n -gt 1) {
        $dir = if ($delta -lt 0) { 1 } else { -1 }   # wheel down = next, up = previous
        $cur = Get-ObjSel $h.project $n
        $script:objSel[$h.project] = ((((($cur + $dir) % $n) + $n) % $n))
        [void](& $h.render)
      }
      return $true   # over a header: consume so the list doesn't also scroll
    }
  } catch {}
  return $false
}
[System.Windows.Forms.Application]::AddMessageFilter((New-Object WheelFilter))

# $rowH, $rowMargin, $badgeSize, $statPx, $statBox are computed in Compute-Dims.

# Tooltip shared by every row's ✕ (hide) button.
$script:rowTip = New-Object System.Windows.Forms.ToolTip

# Get-RepoWebUrl / Get-RepoMenuLabel / Get-RepoSubLinks (the row's repo links) and
# Open-Terminal live in session-ui-repo.ps1, dot-sourced above.

# Live registry of the per-project todo headers, rebuilt on every row rebuild. The
# app-wide wheel hook ([WheelFilter]) hit-tests the cursor against each entry's panel
# to decide which project's list to cycle. Each entry carries a 'render' closure that
# repaints the header in place (counter + checkbox + selected task) without a rebuild.
$script:objHeaders = @()

# Per-project objective header: a slim ONE-LINE bar above each project's session rows.
# It shows a single task at a time — an "i/n" counter, a clickable done checkbox, and
# the task text — with a project-coloured accent on the left and a pencil at the FAR
# right that opens the full task editor. The mouse wheel (captured app-wide) cycles
# through the project's tasks; clicking the checkbox toggles the shown task's done;
# clicking the text (or the pencil) opens the editor.
function Make-GroupHeader($project) {
  $hdrBg = [System.Drawing.Color]::FromArgb(30, 30, 36)
  $pad = New-Object System.Windows.Forms.Panel
  $pad.Width     = $list.ClientSize.Width - ($script:listPadX * 2 + 8)
  $pad.Height    = $script:grpH
  $pad.BackColor = $hdrBg
  $pad.Margin    = New-Object System.Windows.Forms.Padding(0, $script:rowMargin, 0, 2)

  # Project-coloured accent bar — ties the header to the matching badges below it.
  $accent = New-Object System.Windows.Forms.Panel
  $accent.BackColor = Get-ProjectColor $project
  $accent.Location  = New-Object System.Drawing.Point(0, 0)
  $accent.Size      = New-Object System.Drawing.Size(4, $pad.Height)
  $accent.Anchor    = 'Top, Bottom, Left'
  $pad.Controls.Add($accent)

  # Pencil (edit) button, pinned to the far right of the line.
  $edit = New-Object System.Windows.Forms.Label
  $edit.UseCompatibleTextRendering = $true
  $edit.Font      = New-IconFont ([single]($rowPt * 0.95))
  $edit.Text      = Get-IconChar $script:MAT.edit 0x270E
  $edit.ForeColor = [System.Drawing.Color]::FromArgb(130, 130, 140)
  $edit.BackColor = [System.Drawing.Color]::Transparent
  $edit.AutoSize  = $true
  $edit.Cursor    = [System.Windows.Forms.Cursors]::Hand
  $edit.Anchor    = 'Top, Right'
  $editRight = 14
  $edit.Location = New-Object System.Drawing.Point(
    ($pad.Width - $edit.PreferredWidth - $editRight),
    [int](($pad.Height - $edit.PreferredHeight) / 2))
  $script:rowTip.SetToolTip($edit, 'Edit this project''s task list')
  $pad.Controls.Add($edit)
  $edit.BringToFront()
  $edit.Add_MouseEnter({ $this.ForeColor = [System.Drawing.Color]::FromArgb(120, 175, 240) })
  $edit.Add_MouseLeave({ $this.ForeColor = [System.Drawing.Color]::FromArgb(130, 130, 140) })

  # Project name (small, dim) so the bar reads as "<project>  i/n  [x] <task>".
  $name = New-Object System.Windows.Forms.Label
  $name.Text      = $project
  $name.Font      = New-Object System.Drawing.Font('Segoe UI', [single]($rowPt * 0.78), [System.Drawing.FontStyle]::Bold)
  $name.ForeColor = $grey
  $name.AutoSize  = $true
  $name.BackColor = [System.Drawing.Color]::Transparent
  $name.Location  = New-Object System.Drawing.Point(14, [int](($pad.Height - $name.PreferredHeight) / 2))
  $pad.Controls.Add($name)

  # "i/n" task counter (only shown when there is more than one task to scroll).
  $cnt = New-Object System.Windows.Forms.Label
  $cnt.AutoSize  = $true
  $cnt.Font      = New-Object System.Drawing.Font('Segoe UI', [single]($rowPt * 0.72), [System.Drawing.FontStyle]::Regular)
  $cnt.ForeColor = [System.Drawing.Color]::FromArgb(120, 120, 130)
  $cnt.BackColor = $hdrBg        # opaque so a wheel change repaints over the old value
  $cnt.Visible   = $false
  $pad.Controls.Add($cnt)

  # Done checkbox for the currently-shown task (Material glyph; click toggles done).
  $chkPt = [single]($rowPt * 0.95)
  $chk = New-Object System.Windows.Forms.Label
  $chk.UseCompatibleTextRendering = $true
  $chk.Font      = New-IconFont $chkPt
  $chk.AutoSize  = $true
  $chk.BackColor = $hdrBg
  $chk.Cursor    = [System.Windows.Forms.Cursors]::Hand
  $chk.Visible   = $false
  $pad.Controls.Add($chk)
  $script:rowTip.SetToolTip($chk, 'Toggle this task done')

  # The selected task's text (filled by $render). Empty list -> a dim italic prompt.
  $obLbl = New-Object System.Windows.Forms.Label
  $obLbl.AutoSize     = $false
  $obLbl.TextAlign    = 'MiddleLeft'
  $obLbl.AutoEllipsis = $true
  $obLbl.BackColor    = $hdrBg
  $obLbl.Cursor       = [System.Windows.Forms.Cursors]::Hand
  $pad.Controls.Add($obLbl)

  $obPt = [single]($rowPt * 0.92)
  # Checkbox glyph code points captured as LOCALS: $render is GetNewClosure'd, where
  # a direct $script:MAT read resolves to the closure's own (empty) module scope.
  $matChkOn  = $script:MAT.checkOn
  $matChkOff = $script:MAT.checkOff
  # Repaint the header for the current task list + scroll position. Re-reads the
  # live data so it reflects edits/toggles, and lays out counter/checkbox/text from
  # the name's right edge (their widths vary), leaving room for the pencil.
  $render = {
    $tasks = @(Get-OpenTasks $project)     # completed tasks are hidden from the bar
    $n     = $tasks.Count
    Ensure-ObjSel $project                 # default to the first open task on first view
    $sel   = Get-ObjSel $project $n
    $x     = $name.Location.X + $name.PreferredWidth + 10

    if ($n -gt 1) {
      $cnt.Visible  = $true
      $cnt.Text     = ('{0}/{1}' -f ($sel + 1), $n)
      $cnt.Location = New-Object System.Drawing.Point($x, [int](($pad.Height - $cnt.PreferredHeight) / 2))
      $x = $cnt.Location.X + $cnt.PreferredWidth + 8
    } else { $cnt.Visible = $false }

    if ($n -ge 1) {
      $t = $tasks[$sel]
      $chk.Visible   = $true
      $chk.Text      = if ($t.done) { Get-IconChar $matChkOn 0x2611 } else { Get-IconChar $matChkOff 0x2610 }
      $chk.ForeColor = if ($t.done) { $green } else { [System.Drawing.Color]::FromArgb(150, 150, 160) }
      $chk.Location  = New-Object System.Drawing.Point($x, [int](($pad.Height - $chk.PreferredHeight) / 2))
      $x = $chk.Location.X + $chk.PreferredWidth + 6

      $obLbl.Text = [string]$t.text
      if ($t.done) {
        $obLbl.ForeColor = [System.Drawing.Color]::FromArgb(120, 120, 130)
        $obLbl.Font      = New-Object System.Drawing.Font('Segoe UI', $obPt, [System.Drawing.FontStyle]::Strikeout)
      } else {
        $obLbl.ForeColor = $white
        $obLbl.Font      = New-Object System.Drawing.Font('Segoe UI', $obPt, [System.Drawing.FontStyle]::Bold)
      }
    } else {
      $chk.Visible     = $false
      $obLbl.Text      = 'Add a task' + [char]0x2026
      $obLbl.ForeColor = [System.Drawing.Color]::FromArgb(110, 110, 120)
      $obLbl.Font      = New-Object System.Drawing.Font('Segoe UI', [single]($rowPt * 0.88), [System.Drawing.FontStyle]::Italic)
    }
    $obLbl.Location = New-Object System.Drawing.Point($x, 0)
    $obLbl.Size     = New-Object System.Drawing.Size(
      [math]::Max(10, $pad.Width - $x - ($edit.PreferredWidth + $editRight + 12)), $pad.Height)
    $pad.Invalidate()   # clear any area a width change vacated (belt-and-braces vs ghosting)
  }.GetNewClosure()

  # Ticking the checkbox completes the shown (open) task: it then drops out of the bar
  # (completed tasks are hidden here — un-tick from the editor). $open holds the SAME
  # objects as $full, so the done flip is reflected in $full, which we persist.
  $chk.Add_Click({
    $full = @(Get-Tasks $project)
    $open = @($full | Where-Object { -not $_.done })
    $n = $open.Count
    if ($n -lt 1) { return }
    $sel = Get-ObjSel $project $n
    $open[$sel].done = $true
    Set-Tasks $project $full
    Invalidate-List
    & $render
  }.GetNewClosure())

  # Pencil and task text both open the full editor; on Save, force a rebuild.
  $openEditor = {
    $new = Edit-Tasks $project
    if ($null -ne $new) { Set-Tasks $project $new; Invalidate-List; Refresh-List }
  }.GetNewClosure()
  $edit.Add_Click($openEditor)
  $obLbl.Add_Click($openEditor)

  & $render
  $script:objHeaders += ,([pscustomobject]@{ panel = $pad; project = $project; render = $render })
  return $pad
}

function Make-Row($s, $status, $seen, $promptText, $age, $indent) {
  if (-not $indent) { $indent = 0 }
  $btn = New-Object System.Windows.Forms.Button
  $btn.FlatStyle = 'Flat'
  $btn.FlatAppearance.MouseOverBackColor = $hover
  $btn.BackColor = $rowBg
  # Border is reserved for "finished but not opened yet" (unseen completion).
  if ($status -eq 'done' -and -not $seen) {
    $btn.FlatAppearance.BorderSize  = 2
    $btn.FlatAppearance.BorderColor = $unseen
  } else {
    $btn.FlatAppearance.BorderSize = 0
  }
  # Status dot is a Material glyph (own font), so it lives in its own Label to the
  # left of the project badge — the row text stays in Segoe UI.
  switch ($status) {
    'running' { $fc = $green;  $statCode = $script:MAT.dotFull;  $statFb = 0x25CF }  # filled circle (blinks)
    'waiting' { $fc = $orange; $statCode = $script:MAT.dotFull;  $statFb = 0x25CF }  # filled circle
    default   { $fc = $grey;   $statCode = $script:MAT.dotEmpty; $statFb = 0x25CB }  # outlined circle
  }
  $btn.ForeColor = $fc
  $btn.Font = New-Object System.Drawing.Font('Segoe UI', $rowPt)
  $btn.TextAlign = 'MiddleLeft'
  $btn.TextImageRelation = 'ImageBeforeText'
  $btn.ImageAlign = 'MiddleLeft'
  $btn.Image = New-Badge ([string]$s.project) $badgeSize   # coloured square + initials
  $statGap = 12
  $btn.Padding = New-Object System.Windows.Forms.Padding(($script:statBox + $statGap), 0, 18, 0)  # leave room for the status dot
  $btn.Width  = $list.ClientSize.Width - ($script:listPadX * 2 + 8) - $indent
  $btn.Height = $rowH
  $btn.Margin = New-Object System.Windows.Forms.Padding($indent, 0, 0, $rowMargin)
  $btn.TabStop = $false
  $sep = [char]0x2014
  $rest = ('  {0}    {1}    {2}    ({3})' -f $s.project, $sep, $promptText, $age)
  $btn.AutoEllipsis = $true                          # truncate with "…" instead of wrapping to a 2nd line
  $btn.Text = $rest

  # Status dot (Material glyph rendered to a bitmap), pinned at the left edge.
  $statLbl = New-Object System.Windows.Forms.Label
  $statLbl.AutoSize  = $false
  $statLbl.Size      = New-Object System.Drawing.Size($script:statBox, $script:statBox)
  $statLbl.BackColor = [System.Drawing.Color]::Transparent
  $statLbl.Cursor    = [System.Windows.Forms.Cursors]::Hand
  $statLbl.Image     = New-MatIcon $statCode $statFb $script:statPx $fc
  $statLbl.Location  = New-Object System.Drawing.Point(8, [int](($btn.Height - $script:statBox) / 2))
  $btn.Controls.Add($statLbl)
  $statLbl.BringToFront()
  $btn.Tag = $statLbl                                # spinner timer rotates running rows' status dot
  # Dispose every image this row owns (badge + status dot) when the row goes away.
  $btn.Add_Disposed({ param($snd, $e)
    try { if ($snd.Image) { $snd.Image.Dispose() } } catch {}
    try { foreach ($cc in $snd.Controls) { if ($cc.Image) { $cc.Image.Dispose() } } } catch {}
  })

  # Hide (✕) button — pinned to the FAR right of the row. Dismisses this session
  # from the list (Set-Dismissed); it reappears on the session's next activity.
  # It lives in its own Label so its click never triggers the row's focus action.
  $closeLbl = New-Object System.Windows.Forms.Label
  $closeLbl.UseCompatibleTextRendering = $true
  $closeLbl.Font      = New-IconFont ([single]($rowPt * 0.85))
  $closeLbl.Text      = Get-IconChar $script:MAT.close 0x2715
  $closeLbl.ForeColor = [System.Drawing.Color]::FromArgb(110, 110, 120)
  $closeLbl.BackColor = [System.Drawing.Color]::Transparent
  $closeLbl.AutoSize  = $true
  $closeLbl.Cursor    = [System.Windows.Forms.Cursors]::Hand
  $closeLbl.Anchor    = 'Top, Right'
  $script:rowTip.SetToolTip($closeLbl, 'Hide this session (reappears on its next activity)')
  $closeRight = 14
  $closeLbl.Location = New-Object System.Drawing.Point(
    ($btn.Width - $closeLbl.PreferredWidth - $closeRight),
    [int](($btn.Height - $closeLbl.PreferredHeight) / 2))
  $btn.Controls.Add($closeLbl)
  $closeLbl.BringToFront()
  $closeLbl.Add_MouseEnter({ $this.ForeColor = [System.Drawing.Color]::FromArgb(240, 90, 90) })
  $closeLbl.Add_MouseLeave({ $this.ForeColor = [System.Drawing.Color]::FromArgb(110, 110, 120) })
  $closeSlot = $closeLbl.PreferredWidth + $closeRight + 10   # room the ✕ occupies on the right

  # Context size lives in its OWN slot pinned to the right edge — never part of the
  # row text, so a long prompt can't push it onto a second line (the text ellipsizes).
  # Sits just left of the ✕ button.
  $ctxLbl = $null
  $ctxStr = Format-Ctx $s
  if ($ctxStr) {
    $ctxLbl = New-Object System.Windows.Forms.Label
    $ctxLbl.Text      = [char]0x2022 + ' ' + $ctxStr        # • 117k
    $ctxLbl.Font      = New-Object System.Drawing.Font('Segoe UI', [single]($rowPt * 0.85))
    $ctxLbl.ForeColor = $grey
    $ctxLbl.BackColor = [System.Drawing.Color]::Transparent  # let the row bg (breathe/flash) show through
    $ctxLbl.AutoSize  = $true
    $ctxLbl.Cursor    = [System.Windows.Forms.Cursors]::Hand
    $ctxRight = $closeSlot + 4
    $ctxLbl.Anchor   = 'Top, Right'
    $ctxLbl.Location = New-Object System.Drawing.Point(
      ($btn.Width - $ctxLbl.PreferredWidth - $ctxRight),
      [int](($btn.Height - $ctxLbl.PreferredHeight) / 2))
    $btn.Controls.Add($ctxLbl)
  }
  # Reserve room on the right for the ✕ (+ ctx slot when present), but KEEP the
  # left room for the status dot (else the project badge slides over it).
  $rightPad = if ($ctxLbl) { $ctxLbl.PreferredWidth + $ctxRight + 12 } else { $closeSlot + 12 }
  $btn.Padding = New-Object System.Windows.Forms.Padding(($script:statBox + $statGap), 0, $rightPad, 0)

  $proj = [string]$s.project
  $cwd  = [string]$s.cwd
  $sid  = [string]$s.session_id
  $clickHandler = {
    Set-Seen $sid                                          # mark this completion as opened
    # First try to raise an already-open editor window for this project; if none is
    # open (the workspace is closed, possibly with no editor running at all), open
    # the workspace folder in VS Code / Cursor.
    if (-not [WinFocus]::FocusByTitle($proj)) {
      Open-Workspace $cwd | Out-Null
    }
  }.GetNewClosure()
  $btn.Add_Click($clickHandler)
  $statLbl.Add_Click($clickHandler)                   # the status dot is part of the clickable row
  if ($ctxLbl) { $ctxLbl.Add_Click($clickHandler) }   # the ctx slot is part of the clickable row
  # ✕ dismisses the session and refreshes immediately (don't focus the IDE).
  $closeLbl.Add_Click({ Set-Dismissed $sid; $script:lastSig = $null; Refresh-List }.GetNewClosure())

  # Right-click anywhere on the row -> open the project folder / a terminal, plus
  # the repo home and its issues / PRs / CI pages when there's a git remote. All
  # resolved lazily on Opening so we don't touch the filesystem for every row on
  # every refresh; remote-only entries are hidden when there's no remote, and the
  # whole menu is suppressed when nothing applies. The three deep links are reused
  # slots (text/url set on open) so one menu serves GitHub, GitLab or Bitbucket.
  $cmRow      = New-Object System.Windows.Forms.ContextMenuStrip
  $editorItem = New-Object System.Windows.Forms.ToolStripMenuItem('Open in editor')
  $folderItem = New-Object System.Windows.Forms.ToolStripMenuItem('Open folder')
  $termItem   = New-Object System.Windows.Forms.ToolStripMenuItem('Open in terminal')
  $favSep     = New-Object System.Windows.Forms.ToolStripSeparator
  $favItem    = New-Object System.Windows.Forms.ToolStripMenuItem('Add to favorite workspaces')
  $sep1       = New-Object System.Windows.Forms.ToolStripSeparator
  $openItem   = New-Object System.Windows.Forms.ToolStripMenuItem('Open repository in browser')
  $sub1 = New-Object System.Windows.Forms.ToolStripMenuItem('')
  $sub2 = New-Object System.Windows.Forms.ToolStripMenuItem('')
  $sub3 = New-Object System.Windows.Forms.ToolStripMenuItem('')
  $subItems = @($sub1, $sub2, $sub3)
  foreach ($it in @($editorItem, $folderItem, $termItem, $favSep, $favItem, $sep1, $openItem, $sub1, $sub2, $sub3)) { [void]$cmRow.Items.Add($it) }
  $cmRow.Add_Opening({
    param($snd, $e)
    $hasFolder = ($cwd -and (Test-Path -LiteralPath $cwd))
    $editorItem.Visible = $hasFolder
    $folderItem.Visible = $hasFolder
    $termItem.Visible   = $hasFolder
    # Favorite toggle: add this folder, or remove it if it's already saved.
    $favSep.Visible  = $hasFolder
    $favItem.Visible = $hasFolder
    if ($hasFolder) {
      $favItem.Checked = (Test-IsFav $cwd)
      $favItem.Text    = if ($favItem.Checked) { 'Remove from favorite workspaces' } else { 'Add to favorite workspaces' }
    }
    $u = Get-RepoWebUrl $cwd
    if ($u) { $openItem.Visible = $true; $openItem.Text = Get-RepoMenuLabel $u; $openItem.Tag = $u }
    else    { $openItem.Visible = $false }
    $subs = if ($u) { @(Get-RepoSubLinks $u) } else { @() }
    for ($k = 0; $k -lt $subItems.Count; $k++) {
      if ($k -lt $subs.Count) { $subItems[$k].Visible = $true; $subItems[$k].Text = '      ' + $subs[$k].label; $subItems[$k].Tag = $subs[$k].url }
      else { $subItems[$k].Visible = $false }
    }
    $sep1.Visible = ($hasFolder -and $u)
    if (-not $hasFolder -and -not $u) { $e.Cancel = $true }
  }.GetNewClosure())
  $editorItem.Add_Click({ if (-not [WinFocus]::FocusByTitle($proj)) { Open-Workspace $cwd | Out-Null } }.GetNewClosure())
  $folderItem.Add_Click({ if ($cwd) { Start-Process explorer.exe -ArgumentList ('"{0}"' -f $cwd) -ErrorAction SilentlyContinue } }.GetNewClosure())
  $termItem.Add_Click({ Open-Terminal $cwd }.GetNewClosure())
  # Add this project folder to the favorites, or remove it if already there. App
  # defaults to VS Code ('code'); the manager's picker stamps the real app.
  $favItem.Add_Click({
    if (-not $cwd) { return }
    if (Test-IsFav $cwd) { Remove-FavWorkspace $cwd | Out-Null }
    else { Add-FavWorkspace $cwd 'code' 'folder' $proj | Out-Null }
  }.GetNewClosure())
  $openItem.Add_Click({ if ($openItem.Tag) { Start-Process ([string]$openItem.Tag) -ErrorAction SilentlyContinue } }.GetNewClosure())
  foreach ($si in @($sub1, $sub2, $sub3)) { $si.Add_Click({ if ($this.Tag) { Start-Process ([string]$this.Tag) -ErrorAction SilentlyContinue } }) }
  $btn.ContextMenuStrip      = $cmRow
  $statLbl.ContextMenuStrip  = $cmRow
  $closeLbl.ContextMenuStrip = $cmRow
  if ($ctxLbl) { $ctxLbl.ContextMenuStrip = $cmRow }
  return $btn
}

# --- Row background animations ---
#   * waiting rows  -> continuous orange "breathing" (needs your attention)
#   * just-finished -> transient green flash (which session called you)
$script:waitBtns    = @()                                              # buttons currently waiting
$script:flashBtn    = $null
$script:flashStart  = 0
$script:greenHi     = [System.Drawing.Color]::FromArgb(55, 140, 90)
$script:orangeHi    = [System.Drawing.Color]::FromArgb(150, 95, 25)    # blended toward, behind orange text
$script:lastAnimKey = $null

function Blend-Color($a, $b, $m) {
  $r  = [int]($a.R + ($b.R - $a.R) * $m)
  $g  = [int]($a.G + ($b.G - $a.G) * $m)
  $bl = [int]($a.B + ($b.B - $a.B) * $m)
  return [System.Drawing.Color]::FromArgb($r, $g, $bl)
}

$animTimer = New-Object System.Windows.Forms.Timer
$animTimer.Interval = 33
$animTimer.Add_Tick({
  $t = [Environment]::TickCount
  # waiting rows breathe (orange)
  $breathe = 0.30 + 0.30 * (0.5 - 0.5 * [math]::Cos(($t / 900.0) * 2 * [math]::PI))   # ~0.0..0.6
  foreach ($b in @($script:waitBtns)) {
    try { $b.BackColor = (Blend-Color $rowBg $script:orangeHi $breathe) } catch {}
  }
  # just-finished flash (green, fades out over 2.2s, ~3 pulses)
  if ($script:flashBtn) {
    $el = $t - $script:flashStart
    if ($el -ge 2200) {
      try { $script:flashBtn.BackColor = $rowBg } catch {}
      $script:flashBtn = $null
    } else {
      $m = (1.0 - ($el / 2200.0)) * (0.5 - 0.5 * [math]::Cos(($el / 650.0) * 2 * [math]::PI))
      try { $script:flashBtn.BackColor = (Blend-Color $rowBg $script:greenHi $m) } catch { $script:flashBtn = $null }
    }
  }
  if ((@($script:waitBtns).Count -eq 0) -and (-not $script:flashBtn)) { $animTimer.Stop() }
})

# Running rows: the green dot blinks (smooth alpha pulse) — no rotation.
$script:spinLbls = @()   # status Labels of the running rows
$spinTimer = New-Object System.Windows.Forms.Timer
$spinTimer.Interval = 60
$spinTimer.Add_Tick({
  if (@($script:spinLbls).Count -eq 0) { $spinTimer.Stop(); return }
  $k = 0.5 - 0.5 * [math]::Cos(([Environment]::TickCount / 750.0) * 2 * [math]::PI)   # 0..1
  $col = [System.Drawing.Color]::FromArgb([int](80 + 175 * $k), $green.R, $green.G, $green.B)
  foreach ($l in @($script:spinLbls)) {
    try {
      $old = $l.Image
      $l.Image = New-MatIcon $script:MAT.dotFull 0x25CF $script:statPx $col
      if ($old) { $old.Dispose() }
    } catch {}
  }
})

# Collapsed-strip heartbeat: smoothly pulse the orange header toward black (and back)
# while collapsed with an active session. A slow cosine breathe — no flashing — so the
# thin strip reads as "alive". Reuses Blend-Color; Update-CollapsePulse owns start/stop.
$script:pulseBlack = [System.Drawing.Color]::FromArgb(10, 10, 12)
$collapsePulse = New-Object System.Windows.Forms.Timer
$collapsePulse.Interval = 33
$collapsePulse.Add_Tick({
  if (-not $script:collapsed -or -not $script:headerPulseOn) {
    $collapsePulse.Stop(); $script:headerPulseOn = $false
    if ($script:collapsed) { $header.BackColor = $script:collapsedBg }
    return
  }
  $k = 0.5 - 0.5 * [math]::Cos(([Environment]::TickCount / 1300.0) * 2 * [math]::PI)   # 0..1
  $header.BackColor = (Blend-Color $script:collapsedBg $script:pulseBlack (0.55 * $k))
})

$script:lastSig = $null

function Refresh-List {
  # Apply live preference changes (position + opacity + size).
  Read-Prefs
  Read-Objectives                       # per-project objectives (used as group titles)
  Update-PosHighlight
  if ($form.Opacity -ne $script:opacity) { $form.Opacity = $script:opacity }
  if ($script:appliedWidthPct -ne $script:widthPct) {
    $script:appliedWidthPct = $script:widthPct
    Compute-Dims                        # rescale fonts/badges/paddings + width together
    Restyle                             # re-font the header to the new scale
    # Collapsed: keep the thin strip (recomputed for the new scale); else full width.
    $newW            = if ($script:collapsed) { Get-CollapsedWidth } else { $script:formW }
    $script:formLeft = Get-FormLeft $newW
    $form.Width      = $newW
    $form.Left       = $script:formLeft
    $script:lastSig  = $null            # force a row rebuild so rows re-font + reflow
  }
  # Re-apply the preferred placement live (top/bottom snap, or the dragged custom
  # spot) — but never fight an in-progress drag.
  if (-not $script:dragging) {
    $wantLeft = Get-FormLeft $form.Width
    if ($form.Left -ne $wantLeft) { $form.Left = $wantLeft }
    $wantTop = Get-FormTop $form.Height
    if ($form.Top -ne $wantTop) { $form.Top = $wantTop }
  }

  $now = Get-Date
  $sessions = @()
  if (Test-Path $stateDir) {
    foreach ($f in Get-ChildItem $stateDir -Filter *.json -ErrorAction SilentlyContinue) {
      try { $s = [System.IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json } catch { continue }
      try { $upd = [datetime]$s.updated } catch { $upd = $f.LastWriteTime }
      if (($now - $upd).TotalHours -gt 24) { continue }
      # Hidden via the row's ✕ — stays out until its next activity bumps 'updated'.
      if ($s.dismissed -and ([string]$s.dismissed -eq [string]$s.updated)) { continue }
      $sessions += [pscustomobject]@{ s = $s; upd = $upd }
    }
  }
  $sessions = @($sessions | Sort-Object { $_.upd } -Descending)

  # Build display rows (status + duration)
  $rows = @()
  foreach ($e in $sessions) {
    $s = $e.s
    $status = [string]$s.status
    if ($status -ne 'running' -and $status -ne 'waiting') { $status = 'done' }
    $p = [string]$s.last_prompt
    if (-not $p) { $p = '(no prompt)' }
    if ($p.Length -gt 90) { $p = $p.Substring(0, 90) + [char]0x2026 }
    $mins = [int]($now - $e.upd).TotalMinutes
    $age = if ($mins -lt 1) { 'now' } elseif ($mins -lt 60) { "${mins}m" } else { "$([int]($mins / 60))h" }
    $order = switch ($status) { 'waiting' { 0 } 'running' { 1 } default { 2 } }
    $seen  = [bool]$s.seen
    $unseenDone = ($status -eq 'done' -and -not $seen)   # finished & not yet opened -> border
    $rows += [pscustomobject]@{ s = $s; status = $status; p = $p; age = $age; order = $order; upd = $e.upd; seen = $seen; unseenDone = $unseenDone }
  }
  # Sort: waiting first, then running, then done; newest within each group.
  $rows = @($rows | Sort-Object @{ Expression = 'order' }, @{ Expression = 'upd'; Descending = $true })

  # Keep the collapsed-strip heartbeat in sync with the live session count (done
  # before the anti-flicker early-return, so the pulse tracks activity even when the
  # rendered rows are unchanged).
  $script:activeCount = @($rows | Where-Object { $_.status -eq 'running' -or $_.status -eq 'waiting' }).Count
  Update-CollapsePulse

  # Group rows by project: each project becomes an objective header followed by its
  # session rows, indented beneath it. Group order follows the best (lowest) status
  # in the group then its newest activity, so a project with a waiting session floats up.
  $byProject  = @{}
  $projOrder  = @()
  foreach ($r in $rows) {
    $proj = [string]$r.s.project
    if (-not $byProject.ContainsKey($proj)) { $byProject[$proj] = @(); $projOrder += $proj }
    $byProject[$proj] += $r
  }
  $grpList = foreach ($proj in $projOrder) {
    $g = @($byProject[$proj])
    [pscustomobject]@{
      project = $proj
      rows    = @($g | Sort-Object @{ Expression = 'order' }, @{ Expression = 'upd'; Descending = $true })
      order   = ($g | Measure-Object -Property order -Minimum).Minimum
      upd     = (@($g | Sort-Object upd -Descending)[0]).upd
    }
  }
  $grpList = @($grpList | Sort-Object @{ Expression = 'order' }, @{ Expression = 'upd'; Descending = $true })

  # Anti-flicker: only rebuild when the displayed content actually changed. The
  # the task list is part of the signature so editing/toggling repaints immediately.
  $sig = ($rows | ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.s.project, $_.status, $_.p, $_.age, $_.unseenDone, (Get-ObjSig ([string]$_.s.project)) }) -join "`n"
  if ($sig -eq $script:lastSig) { return }
  $script:lastSig = $sig

  # Which session just finished? (newest 'done' row = the one that triggered this update)
  $triggerSid = $null; $triggerKey = $null
  foreach ($r in $rows) {
    if ($r.status -eq 'done') { $triggerSid = [string]$r.s.session_id; $triggerKey = $triggerSid + '|' + [string]$r.s.updated; break }
  }

  # Buttons are about to be recreated; reset animation targets.
  $animTimer.Stop(); $spinTimer.Stop()
  $script:waitBtns = @()
  $script:spinLbls = @()
  $script:flashBtn = $null

  $list.SuspendLayout()
  $list.Controls.Clear()
  $script:objHeaders = @()   # stale panels are about to be disposed; the wheel hook rebuilds its hit-test set
  $triggerBtn = $null
  $waiting = @()
  $spinning = @()
  if ($rows.Count -eq 0) {
    $empty = New-Object System.Windows.Forms.Label
    $empty.Text = 'No active sessions'
    $empty.ForeColor = $grey
    $empty.Font = New-Object System.Drawing.Font('Segoe UI', $rowPt)
    $empty.AutoSize = $true
    $list.Controls.Add($empty)
  } else {
    foreach ($grp in $grpList) {
      $list.Controls.Add((Make-GroupHeader $grp.project))      # objective title + edit pencil
      foreach ($r in $grp.rows) {
        $b = Make-Row $r.s $r.status $r.seen $r.p $r.age $script:rowIndent
        $list.Controls.Add($b)
        if ($r.status -eq 'waiting') { $waiting += $b }
        if ($r.status -eq 'running') { $spinning += $b.Tag }   # $b.Tag = the row's status Label
        if ($triggerSid -and ([string]$r.s.session_id -eq $triggerSid)) { $triggerBtn = $b }
      }
    }
  }
  $list.ResumeLayout()

  # Auto-fit the window height to the number of rows (no big empty area) — skipped
  # while collapsed, where the window is intentionally pinned to the header strip.
  if (-not $script:collapsed) {
    $count   = [math]::Max(1, $rows.Count)
    $grpCount = @($grpList).Count
    $grpBlock = $script:grpH + $rowMargin + 2                  # one objective header (margin matches Make-GroupHeader)
    $desired = $headerH + $listPadV + ($count * ($rowH + $rowMargin)) + ($grpCount * $grpBlock) + 6
    $maxH    = [int]($screen.Height * 0.9)
    $minH    = $headerH + $listPadV + ($rowH + $rowMargin) + $grpBlock + 6
    $newH     = [math]::Min($maxH, [math]::Max($minH, $desired))
    $wantTop  = Get-FormTop $newH
    $wantLeft = Get-FormLeft $form.Width
    if ($form.Height -ne $newH -or $form.Left -ne $wantLeft -or $form.Top -ne $wantTop) {
      $form.Height = $newH
      if (-not $script:dragging) {
        $form.Left = $wantLeft   # custom dragged spot, else horizontally centered
        $form.Top  = $wantTop    # top / center / bottom / dragged per the chosen position
      }
    }
  }

  # Drive animations: running rows spin; waiting rows breathe; a NEW completion flashes once.
  $script:waitBtns = $waiting
  $script:spinLbls = $spinning
  if ($triggerKey -and ($triggerKey -ne $script:lastAnimKey)) {
    $script:lastAnimKey = $triggerKey
    $script:flashBtn    = $triggerBtn
    $script:flashStart  = [Environment]::TickCount
    $script:shownAt     = [Environment]::TickCount   # re-arm the click-outside grace on a fresh pop
  }
  if ((@($script:waitBtns).Count -gt 0) -or $script:flashBtn) { $animTimer.Start() }
  if (@($script:spinLbls).Count -gt 0) { $spinTimer.Start() }
}

# --- Focus-nudge "Matrix" animation -------------------------------------------
# While you're on a distraction the tray keeps focus-nudge.txt fresh. We run a green
# digital-rain gag in the deck's top bar (the "Claude Code Sessions" strip) with a
# one-line wink; it stays up the whole time you stay off-track and fades out once you
# refocus a real app (Check-FocusNudge drives that from the freshness of the stamp).
# The taskbar FlashWindowEx fires when it first appears, and the tray pops the deck
# open if it was closed.
$script:fxCW       = 16     # rain cell width (px)
$script:fxCH       = 18     # rain cell height (px)
$script:fxTrailLen = 11     # glyphs per falling column
$script:fxActive   = $false
$script:fxFading   = $false # set true on click -> fade out, then stop + hide
$script:fxSnoozeUntil = 0   # TickCount until which the nudge stays suppressed (set by hovering the deck)
$script:fxFrame    = 0
$script:fxAlpha    = 1.0
$script:fxHeads    = @()
$script:fxSpeed    = @()
$script:fxLine     = ''
# ASCII glyphs (ASCII only, so any monospace font renders them - no tofu boxes).
$script:fxGlyphs = ('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$+*<>=/\|?!#%&{}[]'.ToCharArray())
# One-line wink (the deck header is a thin strip, so the Claude "mascot" is a
# compact bracket-face rather than the tall ASCII bot). Drawn centered over the rain.
$script:fxLines = @(
  "[o_o]  Wake up... the code won't write itself.",
  "[o_o]  Follow the white rabbit -> your TODOs.",
  "[-_-]  There is no spoon. Only un-merged branches.",
  "[o_o]  Knock knock. Claude wants to build.",
  "[>_>]  I know kung-fu. And also your codebase.",
  "[o_o]  Come back to the Matrix. Bring coffee.")

$script:fxFont      = New-Object System.Drawing.Font('Consolas', 13)
$script:fxArtFont   = New-Object System.Drawing.Font('Consolas', 14, [System.Drawing.FontStyle]::Bold)
# Matrix rain in the brand orange instead of the classic green. The leading head
# and the wink text are the accent blended toward white; the trail is the accent
# scaled down so it fades to a dim ember.
$script:fxAccent = Get-CDAccent
$fxBlend = { param($f) [System.Drawing.Color]::FromArgb(
  [int]($script:fxAccent.R + (255 - $script:fxAccent.R) * $f),
  [int]($script:fxAccent.G + (255 - $script:fxAccent.G) * $f),
  [int]($script:fxAccent.B + (255 - $script:fxAccent.B) * $f)) }
$script:fxHeadBrush = New-Object System.Drawing.SolidBrush (& $fxBlend 0.78)
$script:fxArtBrush  = New-Object System.Drawing.SolidBrush (& $fxBlend 0.45)
$script:fxTrail     = New-Object 'System.Drawing.SolidBrush[]' $script:fxTrailLen
for ($t = 0; $t -lt $script:fxTrailLen; $t++) {
  $k = [math]::Max(60, 255 - $t * 20) / 255.0
  $script:fxTrail[$t] = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(
    [int]($script:fxAccent.R * $k), [int]($script:fxAccent.G * $k), [int]($script:fxAccent.B * $k)))
}

# Full-deck overlay panel the rain is painted onto (hidden until a nudge).
$fx = New-Object System.Windows.Forms.Panel
$fx.BackColor = [System.Drawing.Color]::Black
$fx.Visible = $false
$dbProp.SetValue($fx, $true, $null)   # double-buffer (same trick as the form)
# Hovering the deck = "I'm here, let me work": fade the nudge out AND snooze it so it
# can't instantly snap back from the still-fresh stamp - frees the header for dragging.
$fxDismiss = { $script:fxFading = $true; $script:fxSnoozeUntil = [Environment]::TickCount + 15000 }
$fx.Add_MouseEnter($fxDismiss)
$fx.Add_Click($fxDismiss)
$fx.Add_Paint({
  param($snd, $e)
  $g = $e.Graphics
  $g.Clear([System.Drawing.Color]::Black)
  $w = $fx.ClientSize.Width; $h = $fx.ClientSize.Height
  $cw = $script:fxCW; $ch = $script:fxCH; $tl = $script:fxTrailLen
  $gn = $script:fxGlyphs.Length
  $cols = $script:fxHeads.Length
  for ($c = 0; $c -lt $cols; $c++) {
    $x = $c * $cw
    $head = $script:fxHeads[$c]
    for ($t = 0; $t -lt $tl; $t++) {
      $y = $head - $t * $ch
      if ($y -lt (-$ch) -or $y -gt $h) { continue }
      $row = [int][math]::Floor($y / $ch)
      $idx = [math]::Abs(($c * 131 + $row * 17 + ($script:fxFrame -shr 1) * 5)) % $gn
      $brush = if ($t -eq 0) { $script:fxHeadBrush } else { $script:fxTrail[$t] }
      $g.DrawString([string]$script:fxGlyphs[$idx], $script:fxFont, $brush, [single]$x, [single]$y)
    }
  }
  # Centered one-line wink on a dark backdrop, vertically centered in the bar.
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $lineSize = $g.MeasureString($script:fxLine, $script:fxArtFont)
  $bw = [math]::Min($w, $lineSize.Width + 32)
  $bh = [math]::Min($h, $lineSize.Height + 12)
  $veil = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(175, 0, 0, 0))
  $g.FillRectangle($veil, [single](($w - $bw) / 2), [single](($h - $bh) / 2), [single]$bw, [single]$bh)
  $veil.Dispose()
  $g.DrawString($script:fxLine, $script:fxArtFont, $script:fxArtBrush, (New-Object System.Drawing.RectangleF(0, 0, $w, $h)), $sf)
  # Fade-out veil over the whole frame.
  if ($script:fxAlpha -lt 1.0) {
    $a = [int]((1.0 - $script:fxAlpha) * 255)
    $fb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($a, 0, 0, 0))
    $g.FillRectangle($fb, 0, 0, $w, $h); $fb.Dispose()
  }
})
$form.Controls.Add($fx)

# Seed the falling columns for the current overlay width.
function Fx-Init {
  $cols = [int][math]::Max(1, [math]::Floor($fx.ClientSize.Width / $script:fxCW))
  $script:fxHeads = New-Object 'double[]' $cols
  $script:fxSpeed = New-Object 'double[]' $cols
  for ($i = 0; $i -lt $cols; $i++) {
    $script:fxHeads[$i] = [double](-(Get-Random -Minimum 0 -Maximum ([math]::Max(1, $fx.ClientSize.Height))))
    $script:fxSpeed[$i] = [double](Get-Random -Minimum 8 -Maximum 26)
  }
}

$fxTimer = New-Object System.Windows.Forms.Timer
$fxTimer.Interval = 60
$fxTimer.Add_Tick({
  $script:fxFrame++
  $h = $fx.ClientSize.Height
  for ($i = 0; $i -lt $script:fxHeads.Length; $i++) {
    $script:fxHeads[$i] += $script:fxSpeed[$i]
    if (($script:fxHeads[$i] - $script:fxTrailLen * $script:fxCH) -gt $h) {
      $script:fxHeads[$i] = [double](-(Get-Random -Minimum 0 -Maximum 200))
      $script:fxSpeed[$i] = [double](Get-Random -Minimum 8 -Maximum 26)
    }
  }
  # Runs indefinitely until clicked; a click starts a short fade-out, then we stop.
  if ($script:fxFading) {
    $script:fxAlpha = [math]::Max(0.0, $script:fxAlpha - (1.0 / 8.0))
    if ($script:fxAlpha -le 0.0) {
      $fxTimer.Stop(); $script:fxActive = $false; $script:fxFading = $false; $fx.Visible = $false
      try { $form.Refresh() } catch {}
      return
    }
  }
  $fx.Invalidate()
})

function Flash-Deck {
  try { [WinFocus]::Flash($form.Handle, 4) } catch {}
  if ($script:fxActive) { return }
  $script:fxLine   = $script:fxLines | Get-Random
  $script:fxFrame  = 0
  $script:fxAlpha  = 1.0
  $script:fxFading = $false
  # Header strip only (the "Claude Code Sessions" bar), not the whole deck.
  $fx.Bounds = New-Object System.Drawing.Rectangle(0, 0, $form.ClientSize.Width, $header.Height)
  Fx-Init
  $fx.Visible = $true
  $fx.BringToFront()
  $script:fxActive = $true
  $fxTimer.Start()
}
# The tray re-stamps focus-nudge.txt every ~5s WHILE you're on a distraction. Hold
# the Matrix up the whole time the stamp stays fresh; fade it out once the stamps
# stop (you refocused a real app). Polled on the 1s Pomodoro timer.
function Check-FocusNudge {
  $fresh = $false
  if (Test-Path $nudgeFile) {
    $val = $null
    try { $val = ([System.IO.File]::ReadAllText($nudgeFile)).Trim() } catch {}
    if ($val) {
      $age = 999999
      try { $age = [Environment]::TickCount - [int]$val } catch {}
      if ($age -ge 0 -and $age -lt 12000) { $fresh = $true }   # tray stamps every 5s; 12s grace covers a missed tick
    }
  }
  # Hovering the deck snoozes the nudge for a few seconds so you can grab/move the
  # window without the rain snapping back from the still-fresh stamp.
  if ([Environment]::TickCount -lt $script:fxSnoozeUntil) {
    if ($script:fxActive) { $script:fxFading = $true }
    return
  }
  if ($fresh) {
    if (-not $script:fxActive) { Flash-Deck }                  # first drift -> start the rain
    else { $script:fxFading = $false; $script:fxAlpha = 1.0 }  # still off-track -> keep it solid until you refocus or hover the deck
  } elseif ($script:fxActive) {
    $script:fxFading = $true                                   # stamps stopped -> you refocused -> fade out
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Refresh-List })
$timer.Start()

# Pomodoro display refresh (1s, so the clock ticks smoothly in the header). We also
# piggyback the focus-nudge poll here - same 1s cadence, no extra timer.
$pomoTimer = New-Object System.Windows.Forms.Timer
$pomoTimer.Interval = 1000
$pomoTimer.Add_Tick({ Read-PomoState; Render-Pomo; Check-FocusNudge })
$pomoTimer.Start()

# Follow the user across virtual desktops (feels pinned to all desktops).
$followTimer = New-Object System.Windows.Forms.Timer
$followTimer.Interval = 350
$followTimer.Add_Tick({ try { [VDesk]::FollowToCurrentDesktop($form.Handle) } catch {} })
$followTimer.Start()

$form.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $form.Close() } })

# Close on a click OUTSIDE the window (left or right button), but only after a
# 0.5s grace since it (re)appeared. The window intentionally doesn't steal
# focus, so we poll the global mouse state rather than rely on Deactivate.
$script:shownAt  = [Environment]::TickCount
$script:prevDown = $false
$form.Add_Shown({ $script:shownAt = [Environment]::TickCount; Refresh-List; Read-PomoState; Render-Pomo })

$clickTimer = New-Object System.Windows.Forms.Timer
$clickTimer.Interval = 50
$clickTimer.Add_Tick({
  $down = [WinFocus]::AnyMouseDown()
  if ($down -and -not $script:prevDown -and -not $script:menuOpen -and (([Environment]::TickCount - $script:shownAt) -ge 500) -and (Test-Path $closeFlag)) {
    $b = $form.Bounds
    if ([WinFocus]::CursorOutside($b.Left, $b.Top, $b.Right, $b.Bottom)) { $form.Close() }
  }
  $script:prevDown = $down
})
$clickTimer.Start()

$form.Add_FormClosed({
  $timer.Stop(); $followTimer.Stop(); $animTimer.Stop(); $clickTimer.Stop(); $spinTimer.Stop(); $pomoTimer.Stop(); $pomoPulse.Stop(); $fxTimer.Stop(); $collapsePulse.Stop()
  try { if ($null -ne $script:ghost) { $script:ghost.Dispose() } } catch {}
  # Release the single-instance mutex immediately so the next finished task can
  # pop a fresh view without racing this process's shutdown.
  try { $script:viewMutex.ReleaseMutex() } catch {}
  try { $script:viewMutex.Dispose() } catch {}
  # End the message loop started by Application::Run below.
  try { [System.Windows.Forms.Application]::ExitThread() } catch {}
})

# Show WITHOUT activating (so we don't snatch focus from whatever you're typing),
# then pump messages until the form closes. ShowDialog() is intentionally avoided
# here: it always activates the dialog and would steal the keyboard focus.
$form.Show()
[System.Windows.Forms.Application]::Run()
