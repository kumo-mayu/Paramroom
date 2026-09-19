# Capture the client area of a window (default: VRChat) to a PNG, from the screen (the window must be visible).
#   pwsh capture-window.ps1 -Out shot.png [-Process VRChat]
# Used by local-probe-read.js to read the probe's overlay (docs/research/12).
param([Parameter(Mandatory = $true)][string]$Out, [string]$Process = 'VRChat')
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[Win]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Name $Process -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { throw "no window for process $Process" }
$h = $p.MainWindowHandle
$r = New-Object Win+RECT
[Win]::GetClientRect($h, [ref]$r) | Out-Null
$pt = New-Object Win+POINT
[Win]::ClientToScreen($h, [ref]$pt) | Out-Null
$w = $r.R - $r.L; $hh = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($pt.X, $pt.Y, 0, 0, (New-Object System.Drawing.Size $w, $hh))
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "$w x $hh at $($pt.X),$($pt.Y)"
