# Paramroom 送信アプリの画面を確かめる道具（booth-asset-manager の ui-check を元にした）。呼び出しごとにドットで読み込む：
#   . "D:\work\ClaudeCode\avatar-image-pad\.claude\skills\ui-check\scripts\ui-kit.ps1"
#
# - 起動するときは必ず PARAMROOM_TARGET で宛先を固定する（既定は 127.0.0.1:9131）。確かめの操作で、ユーザが開いている
#   VRChat のアバターに勝手に送らないため。VRChat へ送る確かめは、ユーザに告げてから -AllowVRChat で起動する
# - 保存先（履歴）は PARAMROOM_HOME で %TEMP%paramroom-ui-check-home に分ける
# - 閉じるのは、この道具で起動したアプリだけ
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
if (-not ('ParamroomWin' -as [type])) { Add-Type @"
using System; using System.Runtime.InteropServices;
public static class ParamroomWin {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@ }

$ParamroomRepo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$ParamroomExe = Join-Path $ParamroomRepo 'tools\Paramroom.App\bin\Debug\net9.0-windows\Paramroom.App.exe'
$ParamroomShotDir = Join-Path $env:TEMP 'paramroom-shots'
$ParamroomPidFile = Join-Path $env:TEMP 'paramroom-ui-check.json'
$A_ = [System.Windows.Automation.AutomationElement]
$TS_ = [System.Windows.Automation.TreeScope]

function Start-ParamroomApp {
  param([string]$Target = '127.0.0.1:9131:32:3', [switch]$AllowVRChat, [int]$SettleSeconds = 3)
  if (-not (Test-Path $ParamroomExe)) { throw "ビルドが無い: $ParamroomExe（dotnet build tools/Paramroom.sln）" }
  if (Test-Path $ParamroomPidFile) { try { $old = Get-ParamroomApp; throw "前に起動したアプリがまだ開いている: pid=$($old.Id)（Stop-ParamroomApp）" } catch { if ($_.Exception.Message -like '前に起動した*') { throw } } }
  $psi = [Diagnostics.ProcessStartInfo]::new($ParamroomExe)
  $psi.UseShellExecute = $false; $psi.WorkingDirectory = Split-Path $ParamroomExe
  [void]$psi.Environment.Remove('PARAMROOM_TARGET')
  if (-not $AllowVRChat) { $psi.Environment['PARAMROOM_TARGET'] = $Target }
  # 履歴などの保存先も確かめ用の場所に分ける（ユーザの履歴を書き換えない）
  $psi.Environment['PARAMROOM_HOME'] = (Join-Path $env:TEMP 'paramroom-ui-check-home')
  $p = [Diagnostics.Process]::Start($psi)
  for ($i = 0; $i -lt 120 -and $p.MainWindowHandle -eq 0 -and -not $p.HasExited; $i++) { Start-Sleep -Milliseconds 250; $p.Refresh() }
  if ($p.HasExited -or $p.MainWindowHandle -eq 0) { throw "窓が出なかった（pid=$($p.Id)）" }
  @{ pid = $p.Id; startTicks = $p.StartTime.Ticks } | ConvertTo-Json | Set-Content $ParamroomPidFile
  Start-Sleep -Seconds $SettleSeconds
  $dest = if ($AllowVRChat) { 'OSCQuery（VRChat）' } else { $Target }
  "起動した: pid=$($p.Id) 宛先=$dest"
}

function Get-ParamroomApp {
  if (-not (Test-Path $ParamroomPidFile)) { throw 'この道具で起動したアプリが無い（Start-ParamroomApp）' }
  $info = Get-Content $ParamroomPidFile -Raw | ConvertFrom-Json
  $p = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
  if (-not $p -or $p.StartTime.Ticks -ne [long]$info.startTicks) { Remove-Item $ParamroomPidFile -ErrorAction SilentlyContinue; throw 'この道具で起動したアプリはもう閉じている' }
  $p
}

function Stop-ParamroomApp {
  try { $p = Get-ParamroomApp } catch { return $_.Exception.Message }
  [void]$p.CloseMainWindow()
  if (-not $p.WaitForExit(8000)) { $p.Kill(); [void]$p.WaitForExit(3000) }
  Remove-Item $ParamroomPidFile -ErrorAction SilentlyContinue
  "閉じた: pid=$($p.Id)"
}

function Get-ParamroomRoot { $A_::FromHandle((Get-ParamroomApp).MainWindowHandle) }

function Get-ParamroomElements {
  param([Parameter(Mandatory)][string]$Type, [string]$Name, [string]$Like)
  $ct = [System.Windows.Automation.ControlType]::$Type
  $cond = New-Object System.Windows.Automation.PropertyCondition($A_::ControlTypeProperty, $ct)
  foreach ($e in (Get-ParamroomRoot).FindAll($TS_::Descendants, $cond)) {
    $n = $e.Current.Name
    if ($Name -and $n -ne $Name) { continue }
    if ($Like -and $n -notlike $Like) { continue }
    $e
  }
}

function Get-ParamroomTexts([string]$Like = '*') { Get-ParamroomElements -Type Text -Like $Like | ForEach-Object { $_.Current.Name } }

function Invoke-ParamroomByName {
  param([Parameter(Mandatory)][string]$Name, [string]$Type = 'Button', [double]$WaitSeconds = 1)
  $el = Get-ParamroomElements -Type $Type -Name $Name | Select-Object -First 1
  if (-not $el) { return "無い: $Type「$Name」" }
  if (-not $el.Current.IsEnabled) { return "押せない（無効）: $Type「$Name」" }
  $pats = @($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
  if ($pats -contains 'InvokePatternIdentifiers.Pattern') { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  elseif ($pats -contains 'SelectionItemPatternIdentifiers.Pattern') { $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() }
  else { return "押す操作を持たない: $Type「$Name」" }
  Start-Sleep -Milliseconds ([int]($WaitSeconds * 1000))
  "押した: $Type「$Name」"
}

function Set-ParamroomText {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  $box = Get-ParamroomElements -Type Edit -Name $Name | Select-Object -First 1
  if (-not $box) { return "無い: 入力欄「$Name」" }
  $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Value)
  "入れた: 「$Name」← $Value"
}

# 窓を撮る（前面でなくても撮れる）。-Region は窓の左上からの x,y,幅,高さ。戻りは保存したパス（Read で開いて見る）
function Save-ParamroomShot {
  param([Parameter(Mandatory)][string]$Name, [int[]]$Region)
  $h = (Get-ParamroomApp).MainWindowHandle
  $r = New-Object ParamroomWin+RECT; [void][ParamroomWin]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
  [void][ParamroomWin]::PrintWindow($h, $dc, 2)
  $g.ReleaseHdc($dc); $g.Dispose()
  if ($Region) {
    $x = [Math]::Max(0, [Math]::Min($Region[0], $w - 1)); $y = [Math]::Max(0, [Math]::Min($Region[1], $hh - 1))
    $cw = [Math]::Max(1, [Math]::Min($Region[2], $w - $x)); $ch = [Math]::Max(1, [Math]::Min($Region[3], $hh - $y))
    $crop = $bmp.Clone((New-Object System.Drawing.Rectangle $x, $y, $cw, $ch), $bmp.PixelFormat); $bmp.Dispose(); $bmp = $crop
  }
  New-Item -ItemType Directory -Force $ParamroomShotDir | Out-Null
  $path = Join-Path $ParamroomShotDir "$Name.png"
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  $path
}
