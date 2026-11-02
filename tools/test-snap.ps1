param([int]$Dx = 8, [int]$Dy = 0)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class SnapTest {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[SnapTest]::SetProcessDPIAware() | Out-Null

$proc = Get-Process dsh-island -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw 'island window not found' }
$h = $proc.MainWindowHandle

$r = New-Object SnapTest+RECT
[SnapTest]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
$screenW = [SnapTest]::GetSystemMetrics(0)
$screenH = [SnapTest]::GetSystemMetrics(1)

# Park the window $Dx px inside the right edge - closer than the 22 DIP magnet.
$targetX = $screenW - $w - $Dx
$targetY = [int]($screenH * 0.4)
[SnapTest]::SetWindowPos($h, [IntPtr]::Zero, $targetX, $targetY, 0, 0, 0x0001 -bor 0x0004) | Out-Null
Start-Sleep -Milliseconds 600

[SnapTest]::GetWindowRect($h, [ref]$r) | Out-Null
$gap = $screenW - $r.Right
"screen ${screenW}x${screenH} window $w x $hh"
"moved to $targetX,$targetY -> now $($r.Left),$($r.Top) right-gap=$gap"
