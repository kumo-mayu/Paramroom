---
name: wrap-up
description: 変更を仕上げる（ビルド・テスト・シェーダーの検証・文書の更新・入れてはいけない物の点検・コミット）。実装を終えたとき、「コミットして」と言われたとき、作業の区切りで使う。
---

# 変更の仕上げ

## 1. ビルドとテスト

```bash
dotnet build tools/Paramroom.sln -c Release -v q --nologo 2>&1 | grep -E "エラー|警告" | head -3
dotnet test  tools/Paramroom.sln -c Release --nologo -v q 2>&1 | tail -2
```

出力を丸ごと出さない（文脈を食う）。失敗したときだけ `grep "error CS"` で該当の行を見る。
**72 件が緑でないと進めない。**

**送信アプリが起動しているとビルドが失敗する**（`MSB3027 ... によってロックされています`）。
自分で起動したものなら `ui-check` の `Stop-ParamroomApp`。**ユーザーが開いているなら勝手に落とさず聞く。**

画面を変えたなら Debug も作り直す（`ui-check` が起動するのは Debug）。

## 2. シェーダー・プレハブを変えたなら Unity で動かす

`shader-check` スキル。**コンパイルが通っただけで済ませない。**

## 3. 文書（コードだけ直して置き去りにしない）

| 変えた物 | 直す文書 |
|---|---|
| 測って決めたこと | `docs/research/NN-*.md`（タグ `[実測]` `[推測]` `[公式]` を付ける） |
| 利用者から見える機能・制約 | `README.md`、`measure/unity/Assets/kumo-mayu/Paramroom/README.md` |
| 形式・Int 数・時間の表 | 上の 2 つと `docs/research/09`（QR）。**3 箇所がずれやすい** |
| 依存を足した | `THIRD-PARTY.md`（ライセンスを確かめてから） |

**数字を書き換えたら、他の場所の同じ数字も探す**（`grep` で秒数や MB を追う）。

## 4. 入れてはいけない物の点検

```bash
git status --short
git diff --cached --stat
```

- **個人情報**: サブ PC のホスト名・LAN の IP（`kaito@`・`192.168.`）、`C:\Users\<名前>` を含む絶対パス、
  アバターの blueprint ID（`avtr_`）、スクリーンショットに写った他人の表示名
- **鍵・トークン**: 一度も入ったことは無いが、`git grep -lI "BEGIN .*PRIVATE KEY\|ssh-ed25519"` で確かめる
- **一度きりのスクリプト**: 作業用フォルダの絶対パスが入ったものを `sim/results/` などに置いたままにしない
- **古いビルド成果物**: 改名のあとに `bin`/`obj` に残った古い名前の exe

## 5. コミット

メッセージは**なぜそうしたか**と**何で確かめたか**を日本語で書く（`git log -5` に倣う）。
1 行目は何をしたかを短く、本文に理由と確認方法。

```bash
git add -A
git commit -F - <<'MSG'
<1行目>

<理由。何を測って、どうだったか>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
```

**末尾は `Co-Authored-By` の 1 行だけ。`Claude-Session:` の URL は付けない**（公開リポジトリなので）。
コミットはこまめに。1 つのコミットに 1 つの理由。

## 6. プッシュはしない

**ユーザーが自分で `! git push` する。** こちらは commit まで。
未プッシュの件数を報告に添える（`git status -sb`）。

リリースの公開・リポジトリの設定変更は、**必ず確認を取ってから**。

## 7. 報告（日本語）

- 何を変えたか（ユーザーの言葉で頼まれた単位で）
- **何でどう確かめたか**（テストの件数、Unity の試験の項目数、測った数字）
- **確かめていないこと**（実機の VRChat、他人の環境、長時間の挙動など）
- 判断が要るものがあれば、選択肢と根拠
- 未プッシュの件数
