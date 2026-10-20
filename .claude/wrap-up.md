# Paramroom の仕上げ（harness の wrap-up スキルが読む）

**このリポジトリは公開（github.com/kumo-mayu/Paramroom、PUBLIC）。** commit に入れた物は誰でも読める。

## ビルドとテスト

```bash
set -o pipefail
dotnet build tools/Paramroom.sln -c Release -v q --nologo 2>&1 | grep -E "エラー|警告" | head -3
dotnet test  tools/Paramroom.sln -c Release --nologo -v q 2>&1 | tail -2
```

- 失敗したときだけ `grep "error CS"` で該当の行を見る。**テストが全部緑でないと進めない**（2026-10 時点で 72 件）
- **送信アプリが起動しているとビルドが失敗する**（`MSB3027 ... によってロックされています`）。自分で起動したものなら `ui-check` の `Stop-ParamroomApp`。**ユーザーが開いているなら勝手に落とさず聞く**
- 画面を変えたなら Debug も作り直す（`ui-check` が起動するのは Debug）
- シェーダー・プレハブを変えたなら Unity で動かす（`shader-check` スキル）。**コンパイルが通っただけで済ませない**

## 直す文書

| 変えた物 | 直す文書 |
|---|---|
| 測って決めたこと | `docs/research/NN-*.md`（タグ `[実測]` `[推測]` `[公式]` を付ける） |
| 利用者から見える機能・制約 | `README.md`、`measure/unity/Assets/kumo-mayu/Paramroom/README.md` |
| 形式・Int 数・時間の表 | 上の 2 つと `docs/research/09`（QR）。**3 箇所がずれやすい** |
| 依存を足した | `THIRD-PARTY.md` と `THIRD-PARTY-NOTICES.txt`（ライセンスを確かめてから。間接的な依存も） |

**数字を書き換えたら、他の場所の同じ数字も探す**（`grep` で秒数や MB を追う）。

## 点検（プロジェクトだけの物）

- **個人情報**：サブ PC のホスト名・LAN の IP（`192.168.` など）、`C:\Users\<名前>` を含む絶対パス、アバターの blueprint ID（`avtr_`）、スクリーンショットに写った他人の表示名
- **鍵・トークン**：`git grep -lI "BEGIN .*PRIVATE KEY\|ssh-ed25519"` で確かめる
- **一度きりのスクリプト**：作業用フォルダの絶対パスが入ったものを `sim/results/` などに置いたままにしない
- **古いビルド成果物**：改名のあとに `bin`/`obj` に残った古い名前の exe

## コミットの本文

なぜそうしたかに加えて、**何で確かめたか**（テストの件数、Unity の試験の項目数、測った数字）を書く。

## 報告に足す事

- 未プッシュの件数（`git status -sb`）
- 確かめていない事の例：実機の VRChat、他人の環境、長時間の挙動
