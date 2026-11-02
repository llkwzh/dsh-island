param([int]$TargetX = 6, [int]$TargetY = 6)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class DragTest {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flag, uint dx, uint dy, uint data, IntPtr extra);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[DragTest]::SetProcessDPIAware() | Out-Null
$DOWN = 0x0002; $UP = 0x0004

$proc = Get-Process dsh-island -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw 'island window not found' }
$h = $proc.MainWindowHandle
$r = New-Object DragTest+RECT
[DragTest]::GetWindowRect($h, [ref]$r) | Out-Null
$startX = [int](($r.Left + $r.Right) / 2)
$startY = [int](($r.Top + $r.Bottom) / 2)

[DragTest]::SetCursorPos($startX, $startY) | Out-Null
Start-Sleep -Milliseconds 150
[DragTest]::mouse_event($DOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 120
for ($i = 1; $i -le 40; $i++) {
  $x = [int]($startX + ($TargetX - $startX) * $i / 40)
  $y = [int]($startY + ($TargetY - $startY) * $i / 40)
  [DragTest]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 35
}
Start-Sleep -Milliseconds 450
[DragTest]::mouse_event($UP, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 500

[DragTest]::GetWindowRect($h, [ref]$r) | Out-Null
"from $startX,$startY -> rect $($r.Left),$($r.Top) size $($r.Right - $r.Left)x$($r.Bottom - $r.Top)"
