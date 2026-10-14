# YouTube on V's TV (docs/YOUTUBE_TV.md): places the TV's browser window over the game window and keeps it there.
# Started by bridge/youtube-tv-host.mjs only while a video session is open; it exits with its parent (-ParentId) or on "exit".
#
# Reads one JSON command per line on stdin and writes one JSON event per line on stdout:
#   {"op":"attach","title":"<window title>"}   find the TV window by its title, or that title and " - ..." added by Edge (waits up to 8 s)
#   {"op":"layout","mode":"picker"|"player"}  picker: centred, takes the keyboard; player: above the game's subtitle band, never
#                                             takes focus, and the game gets the keyboard back
#   {"op":"hide"} / {"op":"show"}             hidden while a game menu is open (the game says so)
#   {"op":"exit"}
# Events: {"event":"attached"}, {"event":"placed","mode":..,"x":..,"y":..,"w":..,"h":..}, {"event":"visible","on":bool,"why":..},
#         {"event":"gone"} (the TV window closed), {"event":"error","message":..}
#
# It never sends input to any window. The only thing it does to the game window is read its position and give it the foreground back
# after a video was picked (the player's own click picked it). It polls four times a second, in this process, never in the game.
param([int]$ParentId = 0, [string]$GameProcess = 'Cyberpunk2077', [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch {}
if (-not ('CyberpunkConvaiTv.Native' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace CyberpunkConvaiTv {
  public struct Rect { public int Left, Top, Right, Bottom; }
  public struct Pt { public int X, Y; }
  public static class Native {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Pt point);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hwnd, IntPtr region, bool redraw);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    public static IntPtr FindTitle(string title) {
      IntPtr found = IntPtr.Zero;
      EnumWindows((hwnd, l) => {
        var text = new StringBuilder(512);
        GetWindowText(hwnd, text, 512);
        // Edge may add " - Profile 1 - Microsoft Edge" to the page title; the title carries a random nonce, so its start is unique.
        var name = text.ToString();
        if (name == title || name.StartsWith(title + " - ", StringComparison.Ordinal)) { found = hwnd; return false; }
        return true;
      }, IntPtr.Zero);
      return found;
    }
    // The page's own area: Chromium's render widget child window, the part of the window the page draws in.
    public static bool Content(IntPtr hwnd, out Rect rect) {
      Rect best = new Rect(); bool ok = false; long area = 0;
      EnumChildWindows(hwnd, (child, l) => {
        var name = new StringBuilder(128);
        GetClassName(child, name, 128);
        if (name.ToString() == "Chrome_RenderWidgetHostHWND" && IsWindowVisible(child)) {
          Rect r; GetWindowRect(child, out r);
          long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
          if (a > area) { area = a; best = r; ok = true; }
        }
        return true;
      }, IntPtr.Zero);
      rect = best; return ok;
    }
    public static bool ClientScreen(IntPtr hwnd, out Rect rect) {
      rect = new Rect();
      Rect client; if (!GetClientRect(hwnd, out client)) return false;
      Pt origin = new Pt(); if (!ClientToScreen(hwnd, ref origin)) return false;
      rect.Left = origin.X; rect.Top = origin.Y; rect.Right = origin.X + client.Right; rect.Bottom = origin.Y + client.Bottom;
      return client.Right > 0 && client.Bottom > 0;
    }
    public static void Foreground(IntPtr hwnd) {
      uint pid; IntPtr current = GetForegroundWindow();
      uint mine = GetCurrentThreadId(), theirs = GetWindowThreadProcessId(current, out pid);
      bool attached = theirs != 0 && theirs != mine && AttachThreadInput(mine, theirs, true);
      try { BringWindowToTop(hwnd); SetForegroundWindow(hwnd); }
      finally { if (attached) AttachThreadInput(mine, theirs, false); }
    }
  }
}
'@
}
$N = [CyberpunkConvaiTv.Native]
try { [void]$N::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
$TOPMOST = [IntPtr](-1)
$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = 0x80; $WS_EX_NOACTIVATE = 0x08000000; $WS_EX_APPWINDOW = 0x40000
$SWP_NOACTIVATE = 0x10; $SWP_SHOWWINDOW = 0x40; $SWP_FRAMECHANGED = 0x20
$SW_HIDE = 0; $SW_SHOWNOACTIVATE = 4; $SW_SHOW = 5

function Send($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function GameWindow {
  foreach ($process in [System.Diagnostics.Process]::GetProcessesByName($GameProcess)) {
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) { return $process.MainWindowHandle }
  }
  return [IntPtr]::Zero
}
# Where the page must appear, in screen pixels. Picker: 60% x 70% of the game, centred. Player: the largest 16:9 area in the game's top
# 78%, centred, so the game's own subtitles and dialogue choices in the bottom band stay visible (nothing may cover the player either).
function Target([string]$mode, $game) {
  $w = $game.Right - $game.Left; $h = $game.Bottom - $game.Top
  if ($mode -eq 'picker') {
    $pw = [Math]::Max(480, [int]($w * 0.6)); $ph = [Math]::Max(360, [int]($h * 0.7))
    return @{x = $game.Left + [int](($w - $pw) / 2); y = $game.Top + [int](($h - $ph) / 2); w = $pw; h = $ph}
  }
  $top = [int]($h * 0.04); $avail = [int]($h * 0.78) - $top
  $vw = [Math]::Min($w - [int]($w * 0.04), [int]($avail * 16 / 9)); $vh = [int]($vw * 9 / 16)
  $vw = [Math]::Max(480, $vw); $vh = [Math]::Max(270, $vh)
  return @{x = $game.Left + [int](($w - $vw) / 2); y = $game.Top + $top; w = $vw; h = $vh}
}
$state = @{hwnd = [IntPtr]::Zero; mode = ''; hidden = $false; visible = $false; game = $null; insets = $null; placed = ''}
function Place([bool]$focus) {
  $hwnd = $state.hwnd; if ($hwnd -eq [IntPtr]::Zero -or $state.mode -eq '') { return }
  $gameHwnd = GameWindow
  $game = New-Object CyberpunkConvaiTv.Rect
  if ($gameHwnd -eq [IntPtr]::Zero -or -not $N::ClientScreen($gameHwnd, [ref]$game)) { return }
  $target = Target $state.mode $game
  $key = "$($state.mode):$($target.x):$($target.y):$($target.w):$($target.h)"
  # The four-times-a-second check moves the window only when the game window moved or changed size.
  if (-not $focus -and $key -eq $state.placed) { return }
  $ex = [int64]$N::GetWindowLongPtr($hwnd, $GWL_EXSTYLE)
  $want = ($ex -bor $WS_EX_TOOLWINDOW) -band (-bnot $WS_EX_APPWINDOW)
  if ($state.mode -eq 'player') { $want = $want -bor $WS_EX_NOACTIVATE } else { $want = $want -band (-bnot $WS_EX_NOACTIVATE) }
  if ($want -ne $ex) { [void]$N::SetWindowLongPtr($hwnd, $GWL_EXSTYLE, [IntPtr]$want) }
  # The frame Chromium draws around the page (title bar, borders): measured once, then the window is sized so the page alone lands on
  # the target and a window region cuts the frame away.
  if (-not $state.insets) {
    $outer = New-Object CyberpunkConvaiTv.Rect; [void]$N::GetWindowRect($hwnd, [ref]$outer)
    $inner = New-Object CyberpunkConvaiTv.Rect
    if (-not $N::Content($hwnd, [ref]$inner)) { [void]$N::ClientScreen($hwnd, [ref]$inner) }
    $state.insets = @{l = $inner.Left - $outer.Left; t = $inner.Top - $outer.Top; r = $outer.Right - $inner.Right; b = $outer.Bottom - $inner.Bottom}
  }
  $i = $state.insets
  $flags = $SWP_FRAMECHANGED
  if ($state.mode -eq 'player') { $flags = $flags -bor $SWP_NOACTIVATE }
  if (-not $state.hidden) { $flags = $flags -bor $SWP_SHOWWINDOW }
  [void]$N::SetWindowPos($hwnd, $TOPMOST, $target.x - $i.l, $target.y - $i.t, $target.w + $i.l + $i.r, $target.h + $i.t + $i.b, $flags)
  [void]$N::SetWindowRgn($hwnd, $N::CreateRectRgn($i.l, $i.t, $i.l + $target.w, $i.t + $target.h), $true)
  $state.game = $gameHwnd
  if ($key -ne $state.placed) { $state.placed = $key; Send @{event = 'placed'; mode = $state.mode; x = $target.x; y = $target.y; w = $target.w; h = $target.h} }
  if ($focus) {
    if ($state.mode -eq 'player') { $N::Foreground($gameHwnd) } else { $N::Foreground($hwnd) }
  }
}
function SetVisible([bool]$on, [string]$why) {
  if ($state.hwnd -eq [IntPtr]::Zero -or $state.visible -eq $on) { return }
  $state.visible = $on
  if ($on) { [void]$N::ShowWindow($state.hwnd, $(if ($state.mode -eq 'player') { $SW_SHOWNOACTIVATE } else { $SW_SHOW })) }
  else { [void]$N::ShowWindow($state.hwnd, $SW_HIDE) }
  Send @{event = 'visible'; on = $on; why = $why}
}
# Four times a second: the window shows only while the game (or the TV window itself) is in front and the game is not minimised, and
# follows the game window if it moved or changed size.
function Tick {
  if ($state.hwnd -eq [IntPtr]::Zero) { return }
  if (-not $N::IsWindow($state.hwnd)) { Send @{event = 'gone'}; $state.hwnd = [IntPtr]::Zero; return }
  $gameHwnd = GameWindow
  if ($gameHwnd -eq [IntPtr]::Zero) { SetVisible $false 'no-game'; return }
  $front = $N::GetForegroundWindow()
  $mine = $front -eq $state.hwnd -or $front -eq $gameHwnd
  if (-not $mine -and $front -ne [IntPtr]::Zero) {
    $frontPid = [uint32]0; $tvPid = [uint32]0
    [void]$N::GetWindowThreadProcessId($front, [ref]$frontPid); [void]$N::GetWindowThreadProcessId($state.hwnd, [ref]$tvPid)
    $mine = $frontPid -eq $tvPid
  }
  if ($state.hidden) { SetVisible $false 'game-menu' }
  elseif ($N::IsIconic($gameHwnd)) { SetVisible $false 'game-minimised' }
  elseif (-not $mine) { SetVisible $false 'other-window' }
  else { SetVisible $true 'game-front'; Place $false }
}

$parent = $null
if ($CheckOnly) { Send @{event = 'ready'}; exit 0 }
if ($ParentId -gt 0) { try { $parent = [System.Diagnostics.Process]::GetProcessById($ParentId) } catch { exit 0 } }
# Not [Console]::In: in Windows PowerShell 5.1 its ReadLineAsync runs synchronously, so asking for the next line before handling the
# current one blocked until the bridge wrote again (and the bridge waits for 'attached' first). A StreamReader over the raw stdin
# stream reads on a pool thread.
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
$pending = $reader.ReadLineAsync()
while ($true) {
  if ($parent -and $parent.HasExited) { break }
  if ($pending.Wait(250)) {
    $line = $pending.Result
    if ($null -eq $line) { break }
    $pending = $reader.ReadLineAsync()
    try {
      $command = $line | ConvertFrom-Json
      switch ($command.op) {
        'attach' {
          $deadline = [DateTime]::UtcNow.AddSeconds(8); $state.hwnd = [IntPtr]::Zero; $state.insets = $null; $state.placed = ''
          while ([DateTime]::UtcNow -lt $deadline -and $state.hwnd -eq [IntPtr]::Zero) {
            $state.hwnd = $N::FindTitle([string]$command.title)
            if ($state.hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
          }
          if ($state.hwnd -eq [IntPtr]::Zero) { Send @{event = 'error'; message = 'window-not-found'} } else { $state.visible = $true; Send @{event = 'attached'} }
        }
        'layout' { $state.mode = [string]$command.mode; $state.hidden = $false; Place $true; SetVisible $true 'layout' }
        'hide' { $state.hidden = $true; SetVisible $false 'game-menu' }
        'show' { $state.hidden = $false; Tick }
        'exit' { exit 0 }
      }
    } catch { Send @{event = 'error'; message = $_.Exception.Message} }
  } else { try { Tick } catch { Send @{event = 'error'; message = $_.Exception.Message} } }
}
