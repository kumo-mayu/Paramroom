# tools（C#）

| プロジェクト | 中身 |
|---|---|
| `Paramroom.Core` | UI に依存しない本体。エンコーダー（`PrimEncoder`）、送信（`Sender`・`Schedules`・`Targets`）、送信先の検出（`VrcDiscovery`、OSCQuery）、受け取り側の見え方の描画（`PrimRenderer`）、コマンド（`Commands/UiCommand.cs`・`CommandHandler.cs`）と状態（`Session/`） |
| `Paramroom.App` | 送信アプリ（WPF）。画像の指定（ファイル・URL・ドラッグ・貼り付け）、変換結果のプレビュー、送信の開始と停止、送信途中のプレビュー |
| `ParamroomTool` | コマンドライン版（`paramroom send/encode/list`、使い方は `ParamroomTool/README.md`） |
| `Paramroom.Core.Tests` | Core のテスト（`dotnet test Paramroom.Core.Tests`） |

```
dotnet build Paramroom.sln
dotnet run --project Paramroom.App
```

## 画面と裏側の分け方（booth-asset-manager / vrc-osc-recorder と同じ考え方）

- **画面から裏側への依頼**：必ず `UiCommand` を組み立てて `CommandHandler.ExecuteAsync` に渡す。画面はセッションやエンコーダーを直に呼ばない。新しい操作は `UiCommand` に足し、`CommandHandler` の switch に 1 行足す。
- **裏側から画面への知らせ**：`ParamroomSession.SnapshotChanged` で、状態を丸ごと（`SessionSnapshot`、変更しない record）渡す。
  - 裏のスレッドから届くので、画面は自分のスレッドへ移して当てる。
  - 絵は、参照が変わったときだけ作り直す。
  - 送信中は 1 秒に数回届くため、追いつかないときは最後の 1 つだけ当てる。
- **利点**：画面を作り替えても裏側は変わらない。Core は WPF なしでテストできる（`SessionTests` はコマンドだけで、読み込みから送信・停止までを通している）。

## 画面の確かめ

`.claude/skills/ui-check`。起動時は `PARAMROOM_TARGET=host:port:Int数:format` で宛先を固定し、VRChat へは送らない。
