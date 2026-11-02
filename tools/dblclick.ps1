param([int]$X, [int]$Y, [int]$Gap = 120)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class D {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
}
"@
[D]::SetProcessDPIAware() | Out-Null
[D]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 150
[D]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero); [D]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds $Gap
[D]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero); [D]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero)
Write-Output "dblclick $X,$Y gap=$Gap"
