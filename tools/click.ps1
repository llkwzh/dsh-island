param([int]$X, [int]$Y)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class C {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
}
"@
[C]::SetProcessDPIAware() | Out-Null
[C]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 200
[C]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); [C]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Write-Output "clicked $X,$Y"
