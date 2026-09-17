# ImagePad 送信アプリの画面を確かめる道具（booth-asset-manager の ui-check を元にした）。呼び出しごとにドットで読み込む：
#   . "D:\work\ClaudeCode\avatar-image-pad\.claude\skills\ui-check\scripts\ui-kit.ps1"
#
# - 起動するときは必ず IMAGEPAD_TARGET で宛先を固定する（既定は 127.0.0.1:9131）。確かめの操作で、ユーザが開いている
#   VRChat のアバターに勝手に送らないため。VRChat へ送る確かめは、ユーザに告げてから -AllowVRChat で起動する
# - 閉じるのは、この道具で起動したアプリだけ
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
if (-not ('ImagePadWin' -as [type])) { Add-Type @"
using System; using System.Runtime.InteropServices;
public static class ImagePadWin {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@ }

$ImagePadRepo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$ImagePadExe = Join-Path $ImagePadRepo 'tools\ImagePad.App\bin\Debug\net9.0-windows\ImagePad.App.exe'
$ImagePadShotDir = Join-Path $env:TEMP 'imagepad-shots'
$ImagePadPidFile = Join-Path $env:TEMP 'imagepad-ui-check.json'
$A_ = [System.Windows.Automation.AutomationElement]
$TS_ = [System.Windows.Automation.TreeScope]

function Start-ImagePadApp {
  param([string]$Target = '127.0.0.1:9131:32:3', [switch]$AllowVRChat, [int]$SettleSeconds = 3)
  if (-not (Test-Path $ImagePadExe)) { throw "ビルドが無い: $ImagePadExe（dotnet build tools/ImagePad.sln）" }
  if (Test-Path $ImagePadPidFile) { try { $old = Get-ImagePadApp; throw "前に起動したアプリがまだ開いている: pid=$($old.Id)（Stop-ImagePadApp）" } catch { if ($_.Exception.Message -like '前に起動した*') { throw } } }
  $psi = [Diagnostics.ProcessStartInfo]::new($ImagePadExe)
  $psi.UseShellExecute = $false; $psi.WorkingDirectory = Split-Path $ImagePadExe
  [void]$psi.Environment.Remove('IMAGEPAD_TARGET')
  if (-not $AllowVRChat) { $psi.Environment['IMAGEPAD_TARGET'] = $Target }
  $p = [Diagnostics.Process]::Start($psi)
  for ($i = 0; $i -lt 120 -and $p.MainWindowHandle -eq 0 -and -not $p.HasExited; $i++) { Start-Sleep -Milliseconds 250; $p.Refresh() }
  if ($p.HasExited -or $p.MainWindowHandle -eq 0) { throw "窓が出なかった（pid=$($p.Id)）" }
  @{ pid = $p.Id; startTicks = $p.StartTime.Ticks } | ConvertTo-Json | Set-Content $ImagePadPidFile
  Start-Sleep -Seconds $SettleSeconds
  $dest = if ($AllowVRChat) { 'OSCQuery（VRChat）' } else { $Target }
  "起動した: pid=$($p.Id) 宛先=$dest"
}

function Get-ImagePadApp {
  if (-not (Test-Path $ImagePadPidFile)) { throw 'この道具で起動したアプリが無い（Start-ImagePadApp）' }
  $info = Get-Content $ImagePadPidFile -Raw | ConvertFrom-Json
  $p = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
  if (-not $p -or $p.StartTime.Ticks -ne [long]$info.startTicks) { Remove-Item $ImagePadPidFile -ErrorAction SilentlyContinue; throw 'この道具で起動したアプリはもう閉じている' }
  $p
}

function Stop-ImagePadApp {
  try { $p = Get-ImagePadApp } catch { return $_.Exception.Message }
  [void]$p.CloseMainWindow()
  if (-not $p.WaitForExit(8000)) { $p.Kill(); [void]$p.WaitForExit(3000) }
  Remove-Item $ImagePadPidFile -ErrorAction SilentlyContinue
  "閉じた: pid=$($p.Id)"
}

function Get-ImagePadRoot { $A_::FromHandle((Get-ImagePadApp).MainWindowHandle) }

function Get-ImagePadElements {
  param([Parameter(Mandatory)][string]$Type, [string]$Name, [string]$Like)
  $ct = [System.Windows.Automation.ControlType]::$Type
  $cond = New-Object System.Windows.Automation.PropertyCondition($A_::ControlTypeProperty, $ct)
  foreach ($e in (Get-ImagePadRoot).FindAll($TS_::Descendants, $cond)) {
    $n = $e.Current.Name
    if ($Name -and $n -ne $Name) { continue }
    if ($Like -and $n -notlike $Like) { continue }
    $e
  }
}

function Get-ImagePadTexts([string]$Like = '*') { Get-ImagePadElements -Type Text -Like $Like | ForEach-Object { $_.Current.Name } }

function Invoke-ImagePadByName {
  param([Parameter(Mandatory)][string]$Name, [string]$Type = 'Button', [double]$WaitSeconds = 1)
  $el = Get-ImagePadElements -Type $Type -Name $Name | Select-Object -First 1
  if (-not $el) { return "無い: $Type「$Name」" }
  if (-not $el.Current.IsEnabled) { return "押せない（無効）: $Type「$Name」" }
  $pats = @($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
  if ($pats -contains 'InvokePatternIdentifiers.Pattern') { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  elseif ($pats -contains 'SelectionItemPatternIdentifiers.Pattern') { $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() }
  else { return "押す操作を持たない: $Type「$Name」" }
  Start-Sleep -Milliseconds ([int]($WaitSeconds * 1000))
  "押した: $Type「$Name」"
}

function Set-ImagePadText {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  $box = Get-ImagePadElements -Type Edit -Name $Name | Select-Object -First 1
  if (-not $box) { return "無い: 入力欄「$Name」" }
  $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Value)
  "入れた: 「$Name」← $Value"
}

# 窓を撮る（前面でなくても撮れる）。-Region は窓の左上からの x,y,幅,高さ。戻りは保存したパス（Read で開いて見る）
function Save-ImagePadShot {
  param([Parameter(Mandatory)][string]$Name, [int[]]$Region)
  $h = (Get-ImagePadApp).MainWindowHandle
  $r = New-Object ImagePadWin+RECT; [void][ImagePadWin]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
  [void][ImagePadWin]::PrintWindow($h, $dc, 2)
  $g.ReleaseHdc($dc); $g.Dispose()
  if ($Region) {
    $x = [Math]::Max(0, [Math]::Min($Region[0], $w - 1)); $y = [Math]::Max(0, [Math]::Min($Region[1], $hh - 1))
    $cw = [Math]::Max(1, [Math]::Min($Region[2], $w - $x)); $ch = [Math]::Max(1, [Math]::Min($Region[3], $hh - $y))
    $crop = $bmp.Clone((New-Object System.Drawing.Rectangle $x, $y, $cw, $ch), $bmp.PixelFormat); $bmp.Dispose(); $bmp = $crop
  }
  New-Item -ItemType Directory -Force $ImagePadShotDir | Out-Null
  $path = Join-Path $ImagePadShotDir "$Name.png"
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  $path
}
