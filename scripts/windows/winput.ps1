# Shared Win32 helpers for the interaction tests (dot-source this file).
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ('U' -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class U {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  // SendInput wants cbSize == sizeof(INPUT) exactly (40 bytes on x64, 28 on x86), else it fails with
  // error 87 and the cursor never moves. MOUSEINPUT is the union's largest member, so no padding after it.
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public static IntPtr FindVisible(uint pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (p == pid && IsWindowVisible(h) && sb.ToString() == title) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  const uint MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, ABS = 0x8000;
  static INPUT Mk(uint flags, int x, int y) {
    int w = GetSystemMetrics(0) - 1, h = GetSystemMetrics(1) - 1;
    var i = new INPUT(); i.type = 0; i.mi.dx = (int)Math.Round(x * 65535.0 / w); i.mi.dy = (int)Math.Round(y * 65535.0 / h); i.mi.dwFlags = flags | ABS; return i;
  }
  public static void Move(int x, int y) { SendInput(1, new[] { Mk(MOVE, x, y) }, Marshal.SizeOf(typeof(INPUT))); }
  public static void Down(int x, int y) { SendInput(1, new[] { Mk(MOVE | LDOWN, x, y) }, Marshal.SizeOf(typeof(INPUT))); }
  public static void Up(int x, int y) { SendInput(1, new[] { Mk(MOVE | LUP, x, y) }, Marshal.SizeOf(typeof(INPUT))); }
  public static readonly IntPtr TOPMOST = new IntPtr(-1);
}
"@
}
[U]::SetProcessDPIAware() | Out-Null
function Pump([int]$ms) { $end = [DateTime]::UtcNow.AddMilliseconds($ms); do { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 5 } while ([DateTime]::UtcNow -lt $end) }
function RootAt($x, $y) { $p = New-Object U+POINT; $p.X = $x; $p.Y = $y; [U]::GetAncestor([U]::WindowFromPoint($p), 2) }
function FindOverlay([int]$MainPid) {
  $h = [U]::FindVisible([uint32]$MainPid, 'Perchbot')
  if ($h -eq [IntPtr]::Zero) { foreach ($c in Get-CimInstance Win32_Process -Filter "ParentProcessId=$MainPid") { $h = [U]::FindVisible([uint32]$c.ProcessId, 'Perchbot'); if ($h -ne [IntPtr]::Zero) { break } } }
  $h
}
