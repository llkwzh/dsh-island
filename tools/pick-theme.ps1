$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[M]::SetProcessDPIAware() | Out-Null
$proc = Get-Process dsh-island | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$r = New-Object M+RECT
[M]::GetWindowRect([IntPtr]$proc.MainWindowHandle, [ref]$r) | Out-Null
$cx = $r.Left + 200; $cy = $r.Top + 44
[M]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 120
[M]::mouse_event(0x0008, 0, 0, 0, [IntPtr]::Zero); [M]::mouse_event(0x0010, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 500
# menu anchors at the click point: first item ~24px below, each row ~29px
[M]::SetCursorPos($cx + 20, $cy + 24 + 29 * 1) | Out-Null
Start-Sleep -Milliseconds 250
[M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); [M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 800
Write-Output 'clicked second item (light)'
