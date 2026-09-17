---
name: ui-check
description: ImagePad 送信アプリ（tools/ImagePad.App）の画面を確かめる。起動し、UI Automation で操作し、PrintWindow で撮って見る。画面・文言・レイアウトを直したあとや、「画面を確かめて」と言われたときに使う。
---

# 画面の確かめ

**UI Automation は「要素があるか」しか答えない。「どこにあるか」は答えないので、必ず撮って画像で見る。**

## 道具

`scripts/ui-kit.ps1`（毎回ドットで読み込む）：

```powershell
. "D:\work\ClaudeCode\avatar-image-pad\.claude\skills\ui-check\scripts\ui-kit.ps1"
```

| 関数 | 何をするか |
|---|---|
| `Start-ImagePadApp [-Target host:port:Int数:format]` | `IMAGEPAD_TARGET` で宛先を固定して起動する（既定 `127.0.0.1:9131:32:3`）。**VRChat へは送らない**。VRChat を相手にするときだけ、ユーザに告げてから `-AllowVRChat` を付ける |
| `Stop-ImagePadApp` | この道具で起動したアプリだけ閉じる |
| `Invoke-ImagePadByName -Name '送信を始める'` | ボタンを押す（無効なら押さずに知らせる） |
| `Set-ImagePadText -Name '画像の URL' -Value '...'` | 入力欄に入れる（`AutomationProperties.Name` で探す） |
| `Get-ImagePadTexts [-Like '*送信中*']` | 見えている文字を並べる |
| `Save-ImagePadShot -Name x [-Region x,y,w,h]` | 窓を撮って `%TEMP%\imagepad-shots\x.png` に置く。Read で開いて見る |

## 流れ

1. `dotnet build tools/ImagePad.sln`。自分で起動したアプリが開いていると失敗するので、先に `Stop-ImagePadApp` する。
2. 画像は URL で渡すと、UI Automation だけで操作できる。手元の画像は `node measure/analysis/serve-images.js`（`sim/images/src` を `http://127.0.0.1:8765/` で配る）を裏で動かし、`http://127.0.0.1:8765/kodim23.png` を入れる。
3. 送った中身まで確かめるときは、宛先のポートで UDP を受ける（`measure/osc/check-sender.js` は units の JSON が要る）。
4. 撮って見て、`Stop-ImagePadApp` で閉じる。
