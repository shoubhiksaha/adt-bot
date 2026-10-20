# ADT Bot Windows accessibility helper. Counterpart of electron/native/mac-helper.swift: it reads
# apps' UI Automation trees and acts on their elements so bots can use apps by name ("press Send")
# instead of guessing from screenshots. Driven by electron/features/75-win-control.cjs over the same
# JSON-lines protocol as the Mac helper. Uses only what ships with Windows 10/11 (Windows PowerShell
# 5.1, .NET Framework, the in-box UI Automation client); nothing is installed.
#
# The UIA-tree-first approach and the Invoke/Toggle/SelectionItem/ExpandCollapse order are adapted
# from windows-cua-jev (github.com/foklepoint/windows-cua-jev, MIT, (c) 2026 windows-cua-jev
# contributors), reworked into a long-lived JSON-lines process.
#
# Protocol: one JSON request per line on stdin ({"id":1,"cmd":"snapshot",...}); one JSON reply per
# line on stdout. Every user value arrives as JSON data; nothing is spliced into script source.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

. (Join-Path $PSScriptRoot 'win-helper.native.ps1')
[AdtNative]::MakeDpiAware()

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$rootEl = [System.Windows.Automation.AutomationElement]::RootElement
# ADT Bot's own windows belong to the process that started this helper: never pick them by default.
$appPid = 0
if ($env:ADT_PARENT_PID) { try { $appPid = [int]$env:ADT_PARENT_PID } catch {} }

# Elements from the last two snapshots, by id, so "press 12" works after the model looks again.
$script:current = @{}
$script:previous = @{}
$script:nextId = 1
$script:lastPosted = [AdtNative]::Tick()
$script:lastUser = [AdtNative]::LastInputTick()

# ---- small helpers ---------------------------------------------------------------------------

function Clip($s, [int]$n) {
  if ($null -eq $s) { return "" }
  $t = (([string]$s) -replace "[‎‏‪-‮⁦-⁩﻿]", "") -replace "[\r\n\t]+", " "
  $t = $t.Trim()
  if ($t.Length -gt $n) { return $t.Substring(0, $n - 1) + ([string][char]0x2026) }
  return $t
}

function Fail([string]$message, [string]$code) {
  throw (New-Object System.Management.Automation.RuntimeException ("ADT|" + $code + "|" + $message))
}

# UIA control types -> the role names the Mac side uses, so the renderer formats both the same way.
$ROLE = @{
  'Button' = 'button'; 'CheckBox' = 'checkbox'; 'RadioButton' = 'radio button'; 'ComboBox' = 'combo box';
  'Edit' = 'text field'; 'Document' = 'text area'; 'Hyperlink' = 'link'; 'MenuItem' = 'menu item';
  'TabItem' = 'tab'; 'ListItem' = 'row'; 'TreeItem' = 'row'; 'DataItem' = 'row'; 'Text' = 'text';
  'Image' = 'image'; 'Slider' = 'slider'; 'SplitButton' = 'menu button'; 'Spinner' = 'stepper';
  'Header' = 'heading'; 'HeaderItem' = 'heading'
}
$TEXT_INPUT = @{ 'Edit' = $true; 'Document' = $true; 'ComboBox' = $true }
$ACTIONABLE = @{ 'Button' = $true; 'CheckBox' = $true; 'RadioButton' = $true; 'ComboBox' = $true; 'Edit' = $true;
  'Hyperlink' = $true; 'MenuItem' = $true; 'TabItem' = $true; 'ListItem' = $true; 'TreeItem' = $true;
  'DataItem' = $true; 'SplitButton' = $true; 'Header' = $true; 'HeaderItem' = $true }

function CtName($el) { try { return ($el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') } catch { return '' } }
function TryValue($el) { try { return [string]$el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { return $null } }
function ElPid($el) { try { return [int]$el.Current.ProcessId } catch { return 0 } }
function ForegroundPid { return [AdtNative]::PidOf([AdtNative]::GetForegroundWindow()) }
function ProcName([int]$procId) { try { return (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { return "pid $procId" } }

function SafeInt([double]$v) {
  if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { return 0 }
  return [int][Math]::Max(-1000000000, [Math]::Min(1000000000, $v))
}

function ElFrame($el) {
  try {
    $r = $el.Current.BoundingRectangle
    if ($r.IsEmpty -or [double]::IsInfinity($r.X) -or [double]::IsNaN($r.X)) { return $null }
    return @{ x = (SafeInt $r.X); y = (SafeInt $r.Y); w = (SafeInt $r.Width); h = (SafeInt $r.Height) }
  } catch { return $null }
}

# ---- user activity ---------------------------------------------------------------------------

# Seconds since the user last used the keyboard or mouse, not counting what this helper posted.
function UserIdleSeconds {
  $last = [AdtNative]::LastInputTick()
  if ([AdtNative]::After($last, $script:lastPosted, 300)) {
    if ([AdtNative]::After($last, $script:lastUser, 0)) { $script:lastUser = $last }
  }
  return [AdtNative]::Since($script:lastUser) / 1000.0
}
function MarkPosted { $script:lastPosted = [AdtNative]::Tick() }

function RequireUserPause([string]$what) {
  $deadline = (Get-Date).AddSeconds(4)
  while ((UserIdleSeconds) -lt 1.2) {
    if ((Get-Date) -gt $deadline) {
      $idle = "{0:N1}" -f (UserIdleSeconds)
      Fail ($what + ": the user is using this PC right now (keyboard or mouse used " + $idle + " s ago). Wait for them to pause and try again, or work in the background (mac_ui, mac_press, mac_set_text with the app named).") "busy"
    }
    Start-Sleep -Milliseconds 250
  }
}

# ---- windows ---------------------------------------------------------------------------------

function TopWindows {
  $out = New-Object System.Collections.ArrayList
  try { foreach ($w in $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) { [void]$out.Add($w) } } catch {}
  return , $out
}

function IsAppWindow($w) {
  $p = ElPid $w
  if ($p -eq 0 -or $p -eq $PID -or ($appPid -ne 0 -and $p -eq $appPid)) { return $false }
  if ((CtName $w) -ne 'Window') { return $false }
  return ((Clip $w.Current.Name 200) -ne "")
}

# The top-level window to read: by title, by app (process name or title), else the app in front.
function FindTargetWindow([string]$app, [string]$window) {
  $windows = TopWindows
  if ($window -and $window.Trim() -ne "") {
    $want = (Clip $window 200).ToLower()
    foreach ($w in $windows) { if ((Clip $w.Current.Name 200).ToLower().Contains($want)) { return $w } }
  }
  if ($app -and $app.Trim() -ne "") {
    $want = (Clip $app 200).ToLower()
    $byName = $null; $byPrefix = $null; $byTitle = $null
    foreach ($w in $windows) {
      if (-not (IsAppWindow $w)) { continue }
      $pname = (ProcName (ElPid $w)).ToLower()
      $title = (Clip $w.Current.Name 200).ToLower()
      if ($null -eq $byName -and $pname -eq $want) { $byName = $w }
      if ($null -eq $byPrefix -and $pname.StartsWith($want)) { $byPrefix = $w }
      if ($null -eq $byTitle -and $title.Contains($want)) { $byTitle = $w }
    }
    if ($byName) { return $byName }
    if ($byPrefix) { return $byPrefix }
    if ($byTitle) { return $byTitle }
    Fail ('"' + $app + '" isn''t running. Open it first (mac_open_app).') "not-running"
  }
  $fg = ForegroundPid
  foreach ($w in $windows) { if ((IsAppWindow $w) -and (ElPid $w) -eq $fg) { return $w } }
  foreach ($w in $windows) { if (IsAppWindow $w) { return $w } }
  return $null
}

function TopOf($el) {
  $top = $el
  try { while ($true) { $parent = $walker.GetParent($top); if ($null -eq $parent -or $parent.Equals($rootEl)) { break }; $top = $parent } } catch {}
  return $top
}

function BringForward($el, [string]$what) {
  $procId = ElPid $el
  if ($procId -eq (ForegroundPid)) { return }
  RequireUserPause $what
  try { [void][AdtNative]::SetForegroundWindow([IntPtr]([int64]$el.Current.NativeWindowHandle)) } catch {
    try { [void][AdtNative]::SetForegroundWindow([IntPtr]([int64](TopOf $el).Current.NativeWindowHandle)) } catch {}
  }
  for ($i = 0; $i -lt 20; $i++) { if ($procId -eq (ForegroundPid)) { break }; Start-Sleep -Milliseconds 50 }
  if ($procId -ne (ForegroundPid)) { Fail ($what + ": the app didn't come to the front (the user may have switched apps). Nothing was done.") "not-front" }
}

# ---- snapshot --------------------------------------------------------------------------------

function NewWalk([int]$maxNodes, [string]$query, [double]$seconds) {
  $words = @(); foreach ($w in ((Clip $query 200).ToLower().Split(" "))) { if ($w -ne "") { $words += $w } }
  return @{ nodes = (New-Object System.Collections.ArrayList); maxNodes = $maxNodes; query = $words; deadline = (Get-Date).AddSeconds($seconds); visited = 0; truncated = $false }
}

function WalkMatches($state, [string]$text) {
  if ($state.query.Count -eq 0) { return $true }
  $t = $text.ToLower()
  foreach ($w in $state.query) { if (-not $t.Contains($w)) { return $false } }
  return $true
}

# Depth-first, in reading order. Offscreen subtrees are skipped; text inside a button/row folds into
# that element's label, like the Mac helper.
function Walk($el, $state, $labelOwner) {
  if ($state.visited -ge 6000 -or (Get-Date) -gt $state.deadline) { $state.truncated = $true; return }
  $state.visited++
  $ct = CtName $el
  $frame = ElFrame $el
  $name = $null; try { $name = Clip $el.Current.Name 200 } catch {}
  $offscreen = $false; try { $offscreen = $el.Current.IsOffscreen } catch {}
  $owner = $labelOwner
  $role = $ROLE[$ct]

  if ($ct -eq 'Text' -or $ct -eq 'Image') {
    $text = $name
    if ($ct -eq 'Image') { $text = $null; try { $text = Clip $el.Current.HelpText 200 } catch {} }
    $folded = $false
    if ($null -ne $labelOwner -and $text) {
      foreach ($n in $state.nodes) {
        if ($n.id -eq $labelOwner) {
          $label = [string]$n.label
          if ($label.Length -lt 90 -and -not $label.Contains($text)) {
            if ($label -eq "") { $n.label = Clip $text 120 } else { $n.label = Clip ($label + " " + ([string][char]0x00b7) + " " + $text) 120 }
          }
          $folded = $true; break
        }
      }
    }
    if ($folded) { $role = $null }
    elseif ($ct -eq 'Text' -and $name -and $null -ne $frame -and $frame.w -gt 0) { $role = 'text' }
    else { $role = $null }
  }

  if ($role -and $role -ne 'text' -and $null -ne $frame -and $frame.w -gt 0 -and $frame.h -gt 0) {
    $label = $name
    $value = $null
    if ($TEXT_INPUT.ContainsKey($ct)) {
      $v = TryValue $el; if ($null -ne $v) { $value = Clip $v 300 }
      if (-not $label) { try { $label = Clip $el.Current.HelpText 120 } catch {} }
    } elseif ($ct -ne 'CheckBox' -and $ct -ne 'RadioButton') {
      $v = TryValue $el; if ($null -ne $v -and $v -ne $label) { $value = Clip $v 80 }
    }
    $id = $script:nextId; $script:nextId++
    $node = @{ id = $id; role = $role }
    if ($label) { $node.label = Clip $label 120 }
    if ($null -ne $value -and $value -ne "") { $node.value = $value }
    if ($null -ne $frame) { $node.frame = $frame }
    try { if (-not $el.Current.IsEnabled) { $node.disabled = $true } } catch {}
    try { if ($el.Current.HasKeyboardFocus) { $node.focused = $true } } catch {}
    try { if ($el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { $node.selected = $true } } catch {}
    try { if ($el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) { $node.selected = $true } } catch {}
    if ($TEXT_INPUT.ContainsKey($ct)) { $node.input = $true }
    [void]$state.nodes.Add($node)
    $script:current[$id] = $el
    if ($ACTIONABLE.ContainsKey($ct)) { $owner = $id }
    if ($state.nodes.Count -ge $state.maxNodes * 4) { $state.truncated = $true; return }
  } elseif ($role -eq 'text' -and $name) {
    $id = $script:nextId; $script:nextId++
    $node = @{ id = $id; role = 'text'; label = Clip $name 200 }
    if ($null -ne $frame) { $node.frame = $frame }
    [void]$state.nodes.Add($node)
    $script:current[$id] = $el
  }

  if ($offscreen -and $ct -ne 'Menu' -and $ct -ne 'MenuItem') { return }
  try {
    $child = $walker.GetFirstChild($el)
    while ($null -ne $child) {
      if ($state.truncated) { return }
      Walk $child $state $owner
      $child = $walker.GetNextSibling($child)
    }
  } catch {}
}

function Snapshot($req) {
  $app = [string]$req.app
  $target = FindTargetWindow $app ([string]$req.window)
  $maxNodes = 200; if ($req.max) { $maxNodes = [int]$req.max }
  if ($maxNodes -lt 20) { $maxNodes = 20 }; if ($maxNodes -gt 600) { $maxNodes = 600 }
  $seconds = 4; if ($req.menus -eq $true) { $seconds = 8 }
  $state = NewWalk $maxNodes ([string]$req.query) $seconds

  $script:previous = $script:current
  $script:current = @{}
  $script:nextId = 1

  $titles = @(); foreach ($w in (TopWindows)) { $t = Clip $w.Current.Name 120; if ($t -ne "") { $titles += $t } }
  $procId = 0; $windowTitle = ""; $windowFrame = $null
  if ($null -ne $target) {
    $procId = ElPid $target
    $windowTitle = Clip $target.Current.Name 120
    $windowFrame = ElFrame $target
    Walk $target $state $null
  }

  $matched = $state.nodes.Count
  $nodes = $state.nodes
  if ($nodes.Count -gt $maxNodes) {
    $trimmed = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $maxNodes; $i++) { [void]$trimmed.Add($nodes[$i]) }
    $nodes = $trimmed; $state.truncated = $true
  }

  $out = @{}
  if ($procId -gt 0) { $out.name = Clip (ProcName $procId) 80; $out.pid = $procId } else { $out.name = Clip $app 80; $out.pid = 0 }
  $out.bundleId = $null
  $out.window = $windowTitle
  if ($null -ne $windowFrame) { $out.windowFrame = $windowFrame }
  $out.windows = $titles
  $out.elements = @($nodes)
  $out.matched = $matched
  $out.truncated = $state.truncated
  $out.frontmost = ($procId -gt 0 -and $procId -eq (ForegroundPid))
  if ($null -eq $target) { $out.note = "No window could be read." }
  return $out
}

# ---- actions ---------------------------------------------------------------------------------

function ResolveElement($req) {
  $id = [int]$req.element
  $el = $null
  if ($script:current.ContainsKey($id)) { $el = $script:current[$id] } elseif ($script:previous.ContainsKey($id)) { $el = $script:previous[$id] }
  if ($null -eq $el) { Fail ("Element $id isn't in the latest UI list. List the UI again (mac_ui).") "stale" }
  try { $null = $el.Current.ControlType } catch { Fail ("That element is gone (the window changed). List the UI again (mac_ui).") "stale" }
  return $el
}

function ElementCenter($el) {
  $f = ElFrame $el
  if ($null -eq $f -or $f.w -le 0 -or $f.h -le 0) { Fail "That element has no position on screen." "" }
  return @{ x = [int]($f.x + $f.w / 2); y = [int]($f.y + $f.h / 2) }
}

# A real click for the user's sake: the pointer goes back where it was so they can keep working.
function ClickAndReturn([int]$x, [int]$y, [int]$button, [int]$clicks) {
  $was = [AdtNative]::Cursor()
  MarkPosted
  [AdtNative]::Click($x, $y, $button, $clicks)
  Start-Sleep -Milliseconds 40
  [AdtNative]::Move($was[0], $was[1])
  MarkPosted
}

function LooseEq([string]$a, [string]$b) {
  $f = { param($s) (([string]$s) -replace "[‎‏‪-‮⁦-⁩﻿\s]", "").ToLower() }
  return (& $f $a) -eq (& $f $b)
}

function PressCmd($req) {
  $el = ResolveElement $req
  $how = [string]$req.action; if (-not $how) { $how = "press" }
  if ($how -eq "press") {
    try { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return @{ method = "Invoke" } } catch {}
    try { $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); return @{ method = "Toggle" } } catch {}
    try { $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); return @{ method = "select" } } catch {}
    try { $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); return @{ method = "Expand" } } catch {}
  }
  if ($how -eq "focus") {
    BringForward $el "Focusing"
    try { $el.SetFocus(); return @{ method = "focus"; ok = $true } } catch { return @{ method = "focus"; ok = $false } }
  }
  $c = ElementCenter $el
  BringForward $el "Clicking"
  RequireUserPause "Clicking"
  $button = 0; if ($how -eq "right_click") { $button = 1 }
  $clicks = 1; if ($how -eq "double_click") { $clicks = 2 }
  Start-Sleep -Milliseconds 80
  ClickAndReturn $c.x $c.y $button $clicks
  return @{ method = "click"; x = $c.x; y = $c.y }
}

# Puts text in a field. Background: ValuePattern.SetValue without stealing focus, verified by reading
# back. Otherwise the field is focused (clicked if focusing fails) and typed like a person, but only
# when the app is in front and the user is idle.
function SetTextCmd($req) {
  $el = ResolveElement $req
  $text = [string]$req.text
  $replace = -not ($req.replace -eq $false)
  $submit = ($req.submit -eq $true)
  $background = -not ($req.background -eq $false)
  $old = ""; $v = TryValue $el; if ($null -ne $v) { $old = [string]$v }
  if ($replace) { $expected = $text } else { $expected = $old + $text }
  $procId = ElPid $el
  $frontmost = ($procId -eq (ForegroundPid))
  $out = @{ typed = $text.Length }

  if (-not $frontmost -and $background -and $text -ne "") {
    try {
      $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if (-not $vp.Current.IsReadOnly) {
        try { $el.SetFocus() } catch {}
        $vp.SetValue($expected)
        Start-Sleep -Milliseconds 80
        $now = [string](TryValue $el)
        if (LooseEq $now $expected) {
          $out.background = "value"
          if ($submit) { $out.submitted = "unconfirmed"; $out.value = Clip $now 300 } else { $out.value = Clip $now 300 }
          return $out
        }
      }
    } catch {}
  }

  BringForward $el "Typing"
  try { $el.SetFocus() } catch {}
  Start-Sleep -Milliseconds 120
  $focused = $false; try { $focused = $el.Current.HasKeyboardFocus } catch {}
  if (-not $focused) { RequireUserPause "Typing"; $c = ElementCenter $el; ClickAndReturn $c.x $c.y 0 1; Start-Sleep -Milliseconds 150 }
  RequireUserPause "Typing"
  if ($procId -ne (ForegroundPid)) { Fail ("Typing: the app isn't in front any more (the user switched apps). Nothing was typed.") "not-front" }
  if ($replace -and $old -ne "") {
    MarkPosted
    [AdtNative]::SelectAll()
    Start-Sleep -Milliseconds 50
    if ($text -eq "") { [AdtNative]::TapKey(0x2E) }
  } elseif (-not $replace) { [AdtNative]::TapKey(0x23) }
  MarkPosted
  [AdtNative]::TypeUnicode($text)
  Start-Sleep -Milliseconds 150
  if ($submit) {
    $nowv = [string](TryValue $el)
    if ($procId -ne (ForegroundPid) -or -not (LooseEq $nowv $expected)) { $out.submitted = "skipped"; $out.value = Clip $nowv 300; return $out }
    if ((UserIdleSeconds) -lt 1.0) { $out.submitted = "skipped"; $out.reason = "busy"; $out.value = Clip $nowv 300; return $out }
    MarkPosted
    [AdtNative]::TapKey(0x0D)
    Start-Sleep -Milliseconds 100
    $out.submitted = "keys"
  } else { $out.value = Clip ([string](TryValue $el)) 300 }
  return $out
}

# The app named in a request, running and not in front: input is aimed at it by bringing it forward.
function BackgroundTargetPid($req) {
  $app = [string]$req.app
  if (-not $app) { return 0 }
  $w = FindTargetWindow $app ""
  if ($null -eq $w) { return 0 }
  $procId = ElPid $w
  if ($procId -eq (ForegroundPid)) { return 0 }
  try { [void][AdtNative]::SetForegroundWindow([IntPtr]([int64]$w.Current.NativeWindowHandle)); Start-Sleep -Milliseconds 200 } catch {}
  return $procId
}

function TypeCmd($req) {
  $text = [string]$req.text
  $procId = BackgroundTargetPid $req
  if ($procId -eq 0) { RequireUserPause "Typing" }
  MarkPosted
  [AdtNative]::TypeUnicode($text)
  if ($procId -eq 0) { return @{ typed = $text.Length; to = "front" } } else { return @{ typed = $text.Length; to = "app" } }
}

$MODVK = @{ 'command' = 0x11; 'control' = 0x11; 'ctrl' = 0x11; 'shift' = 0x10; 'option' = 0x12; 'alt' = 0x12; 'win' = 0x5B; 'super' = 0x5B }

function KeyCmd($req) {
  $mods = New-Object System.Collections.ArrayList
  if ($req.modifiers) { foreach ($m in $req.modifiers) { $vk = $MODVK[[string]$m]; if ($null -eq $vk) { Fail "Unknown modifier $m." "" }; [void]$mods.Add([uint16]$vk) } }
  $procId = BackgroundTargetPid $req
  if ($procId -eq 0) { RequireUserPause "Pressing the key" }
  MarkPosted
  $modArr = [uint16[]]$mods.ToArray([uint16])
  if ($null -ne $req.code) { [AdtNative]::KeyCombo($modArr, [uint16][int]$req.code) }
  elseif ($req.char) { [AdtNative]::CharCombo($modArr, ([string]$req.char)[0]) }
  else { Fail "Give a key code or a character." "" }
  if ($procId -eq 0) { return @{ ok = $true; to = "front" } } else { return @{ ok = $true; to = "app" } }
}

function ClickCmd($req) {
  RequireUserPause "Clicking"
  $b = 0; if ($req.button -eq "right") { $b = 1 } elseif ($req.button -eq "middle") { $b = 2 }
  $clicks = 1; if ($req.clicks) { $clicks = [int]$req.clicks }
  MarkPosted
  [AdtNative]::Click([int]$req.x, [int]$req.y, $b, $clicks)
  MarkPosted
  return @{ ok = $true }
}

function MoveCmd($req) { MarkPosted; [AdtNative]::Move([int]$req.x, [int]$req.y); return @{ ok = $true } }
function ScrollCmd($req) { RequireUserPause "Scrolling"; MarkPosted; [AdtNative]::Scroll([int]$req.x, [int]$req.y, [int]$req.dx, [int]$req.dy); return @{ ok = $true } }
function DragCmd($req) { RequireUserPause "Dragging"; MarkPosted; [AdtNative]::Drag([int]$req.x, [int]$req.y, [int]$req.toX, [int]$req.toY); return @{ ok = $true } }
function CursorCmd { $p = [AdtNative]::Cursor(); return @{ x = $p[0]; y = $p[1] } }

function AppsCmd {
  $out = New-Object System.Collections.ArrayList
  $fg = ForegroundPid
  $seen = @{}
  foreach ($w in (TopWindows)) {
    if (-not (IsAppWindow $w)) { continue }
    $procId = ElPid $w
    if ($seen.ContainsKey($procId)) { continue }
    $seen[$procId] = $true
    $off = $false; try { $off = $w.Current.IsOffscreen } catch {}
    [void]$out.Add(@{ name = (Clip (ProcName $procId) 80); bundleId = $null; pid = $procId; active = ($procId -eq $fg); hidden = $off })
  }
  return @{ apps = @($out) }
}

function FrontCmd {
  $h = [AdtNative]::GetForegroundWindow()
  $procId = [AdtNative]::PidOf($h)
  if ($procId -eq 0) { return $null }
  $title = $null
  try { $title = Clip ([System.Windows.Automation.AutomationElement]::FromHandle($h)).Current.Name 120 } catch {}
  $r = [AdtNative]::RectOf($h)
  return @{ name = (Clip (ProcName $procId) 80); bundleId = $null; pid = $procId; window = $title; bounds = @{ x = $r[0]; y = $r[1]; width = $r[2]; height = $r[3] } }
}

function ScreenshotCmd($req) {
  $v = [AdtNative]::Virt()
  $x = $v[0]; $y = $v[1]; $w = $v[2]; $h = $v[3]
  if ($req.region) { $x = [int]$req.region.x; $y = [int]$req.region.y; $w = [int]$req.region.width; $h = [int]$req.region.height }
  if ($w -lt 1) { $w = 1 }; if ($h -lt 1) { $h = 1 }
  [AdtNative]::CapturePng($x, $y, $w, $h, [string]$req.path)
  return @{ x = $x; y = $y; width = $w; height = $h }
}

# The app named, looked up in the Start menu and launched without a command shell.
function OpenCmd($req) {
  $name = [string]$req.name
  $target = $null
  try {
    $shell = New-Object -ComObject Shell.Application
    $apps = $shell.NameSpace('shell:AppsFolder')
    foreach ($item in $apps.Items()) {
      $n = [string]$item.Name
      if ($n.ToLower() -eq $name.ToLower() -or $n.ToLower().StartsWith($name.ToLower())) { $target = $item; if ($n.ToLower() -eq $name.ToLower()) { break } }
    }
  } catch {}
  if ($null -eq $target) { Fail ('No app named "' + $name + '" is installed.') "not-found" }
  try { $target.InvokeVerb('Open') } catch { Start-Process ("shell:AppsFolder\" + $target.Path) }
  return @{ name = [string]$target.Name }
}

# ---- dispatch --------------------------------------------------------------------------------

$NEEDS_UNLOCKED = @{ 'snapshot' = $true; 'press' = $true; 'setText' = $true; 'type' = $true; 'key' = $true; 'click' = $true; 'move' = $true; 'drag' = $true; 'scroll' = $true }

function HandleReq($req) {
  $cmd = [string]$req.cmd
  if ($NEEDS_UNLOCKED.ContainsKey($cmd) -and [AdtNative]::Locked()) {
    Fail "This PC's screen is locked, so apps can't be seen or used. Ask the user to unlock it, then try again." "locked"
  }
  switch ($cmd) {
    'ping' { return @{ trusted = $true; pid = $PID; locked = [AdtNative]::Locked(); idle = (UserIdleSeconds) } }
    'idle' { return @{ idle = (UserIdleSeconds) } }
    'geometry' { $v = [AdtNative]::Virt(); return @{ x = $v[0]; y = $v[1]; width = $v[2]; height = $v[3]; backing = 1 } }
    'snapshot' { return Snapshot $req }
    'press' { return PressCmd $req }
    'setText' { return SetTextCmd $req }
    'type' { return TypeCmd $req }
    'key' { return KeyCmd $req }
    'click' { return ClickCmd $req }
    'move' { return MoveCmd $req }
    'scroll' { return ScrollCmd $req }
    'drag' { return DragCmd $req }
    'cursor' { return CursorCmd }
    'apps' { return AppsCmd }
    'front' { return FrontCmd }
    'screenshot' { return ScreenshotCmd $req }
    'open' { return OpenCmd $req }
    default { Fail "Unknown command." "" }
  }
}

function Reply($obj) {
  $line = ConvertTo-Json $obj -Compress -Depth 8
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq "") { continue }
  $req = $null
  try { $req = ConvertFrom-Json $line } catch { continue }
  $msgId = $req.id
  try {
    $result = HandleReq $req
    Reply @{ id = $msgId; result = $result }
  } catch {
    $msg = [string]$_.Exception.Message
    $code = $null
    if ($msg.StartsWith("ADT|")) { $parts = $msg.Split([char]'|', 3); $code = $parts[1]; $msg = $parts[2]; if ($code -eq "") { $code = $null } }
    Reply @{ id = $msgId; error = $msg; code = $code }
  }
}
