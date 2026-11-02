$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[W]::SetProcessDPIAware() | Out-Null
$proc = Get-Process dsh-island | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output 'no-window'; exit 1 }
$h = $proc.MainWindowHandle
$r = New-Object W+RECT
[W]::GetWindowRect([IntPtr]$h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
Write-Output ("pid {0} rect {1},{2} {3}x{4}" -f $proc.Id, $r.Left, $r.Top, $w, $ht)
$cx = $r.Left + [int]($w / 2); $cy = $r.Top + [int]($ht / 2)
[W]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 150
[W]::mouse_event(0x0008, 0, 0, 0, [IntPtr]::Zero)
[W]::mouse_event(0x0010, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 700
$bmp = New-Object System.Drawing.Bitmap 560, 460
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size 560, 460))
$out = Join-Path $PSScriptRoot "..\.shots\menu.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $out"
