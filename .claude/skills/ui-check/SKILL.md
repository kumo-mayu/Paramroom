---
name: ui-check
description: Paramroom 送信アプリ（tools/Paramroom.App）の画面を確かめる。起動し、UI Automation で操作し、PrintWindow で撮って見る。画面・文言・レイアウトを直したあとや、「画面を確かめて」と言われたときに使う。
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
| `Start-ParamroomApp [-Target host:port:Int数:format]` | `PARAMROOM_TARGET` で宛先を固定して起動する（既定 `127.0.0.1:9131:32:3`）。**VRChat へは送らない**。VRChat を相手にするときだけ、ユーザに告げてから `-AllowVRChat` を付ける |
| `Stop-ParamroomApp` | この道具で起動したアプリだけ閉じる |
| `Invoke-ParamroomByName -Name '送信を始める'` | ボタンを押す（無効なら押さずに知らせる） |
| `Set-ParamroomText -Name '画像の URL' -Value '...'` | 入力欄に入れる（`AutomationProperties.Name` で探す） |
| `Get-ParamroomTexts [-Like '*送信中*']` | 見えている文字を並べる |
| `Save-ParamroomShot -Name x [-Region x,y,w,h]` | 窓を撮って `%TEMP%\paramroom-shots\x.png` に置く。Read で開いて見る |

## 流れ

1. **`dotnet build tools/Paramroom.sln -c Debug`**（この道具が起動するのは Debug のビルド。
   Release だけ作り直しても画面は変わらないので注意）。
   - 自分で起動したアプリが開いていると失敗するので、先に `Stop-ParamroomApp` する
   - **ユーザーが自分で起動していることもある**（`MSB3027 ... によってロックされています` に別の pid が出る）。
     その場合は勝手に落とさず、閉じてよいか聞く
2. 画像は URL で渡すと、UI Automation だけで操作できる。手元の画像は `node measure/analysis/serve-images.js`（`sim/images/src` を `http://127.0.0.1:8765/` で配る）を裏で動かし、`http://127.0.0.1:8765/kodim23.png` を入れる。
3. 送った中身まで確かめるときは、宛先のポートで UDP を受ける（`measure/osc/check-sender.js` は units の JSON が要る）。
4. 撮って見て、`Stop-ParamroomApp` で閉じる。
