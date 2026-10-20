---
name: release
description: Paramroom の版を出す（版の決め方、配布物の作り方、GitHub の Releases と BOOTH の用意）。リリースを出すとき、配布物（exe・unitypackage・BOOTH 用の zip）を作るとき、「リリースして」「BOOTH を更新して」と言われたときに使う。
disable-model-invocation: true
---

# リリースの出しかた

公開・差し替えは外向きの操作。**行う前に必ず確認を取る。** BOOTH の差し替え・公開はユーザーが自分で行う。

## 版の決め方

**期間で区切らない。「アバターの作り直しが要るか」で分ける。**
利用者の手間が桁違いに違うので、そこが分かれ目になる。

| 変更の種類 | 利用者の手間 | 出し方 | 版 |
|---|---|---|---|
| **アプリだけ** | exe を置き換えるだけ（30 秒） | **溜めずに出す。** 実害のある不具合を直したらその日のうち | パッチ（0.2.**1**） |
| **シェーダー・プレハブ** | Unity を開く→作り直す→アップロード→反映待ち（30 分以上） | **溜めてから出す。** 月 1 回以下 | マイナー（0.**3**.0） |

ビルダーの既定や文言だけの変更（できるプレハブは同じ）は**作り直し不要**なので、パッチで出してよい。
unitypackage は中身が変わるので新しいものを添付し、「作り直しは不要」とノートに書く。

- **アバターの作り直しが要るかどうかを、リリースノートの冒頭に必ず書く**
- **公開したリリースの中身は動かさない。** 差し替えたくなったら新しい版を出す
- unitypackage が前の版と同じでも**毎回添付する**。「どれとどれを組み合わせるのか」で迷わせない
  （同じであることはノートに書く）

## 配布物の作り方

`bash tools/release/make-release.sh v0.X.Y <前の版> [出力先]` で、exe・unitypackage・LICENSE・
THIRD-PARTY-NOTICES.txt・README.txt・BOOTH 用の zip がまとめてできる（出力先の既定は
`D:/work/ClaudeCode/Paramroom-release`。リポジトリの外）。先に `docs/booth/zip-README.txt` を直す。

- **BOOTH 用の zip には ShotLink（写真に写った QR を PC で受け取るアプリ。別リポジトリ `kumo-mayu/shotlink`）を
  おまけとしてフォルダごと同梱する。** 4つ目の引数で版を選ぶ（既定 `latest`＝公開済みの最新、`none` で入れない）。
  取ってくるのは `tools/release/fetch-shotlink.sh`（ShotLink の zip に添えた `.sha256` で確かめる）。
  ShotLink を更新するたびに Paramroom を差し替えはしない。Paramroom の版を出すときに、その時点の最新を入れる。
  ShotLink の公開前は `latest` が見つからずに止まるので、`none` を付ける。zip の README の「（版）」は、入れた版に直す

- **unitypackage の GUID は前の版から引き継ぐ。** リポジトリに `.meta` が無いので、スクリプトは
  前の版の unitypackage を土台に中身だけ差し替える。GUID が変わると上書きされず、
  生成済みのプレハブがシェーダーを見失う。ファイルを足したときは Unity で書き出す
- **公開したら、添付物がスクリプトの出力と同じかをハッシュで突き合わせる**（`gh release download` して `sha256sum`）。
  v0.2.1 では、GitHub に v0.2.0 と同じ unitypackage が付き、THIRD-PARTY-NOTICES.txt も付いていなかった
  （2026-09-19 に v0.2.2 の準備中に気づき、v0.2.2 のノートで訂正した）
- exe は `IncludeNativeLibrariesForSelfExtract` と `EnableCompressionInSingleFile` を付けて作る。
  無いと WPF のネイティブ DLL が外に出て、exe 1 つでは起動できない

## BOOTH（`kumo-mayu.booth.pm`、カテゴリ「ソフトウェア」）

GitHub の Releases と**同じ中身**を BOOTH にも置く。BOOTH の規約で、外部サイトへ案内するだけの商品は
禁止されているので、**「GitHub から取ってください」で済ませない**。

- バリエーションは「無料版」（¥0）と「支援版(中身は同じ)」（¥500）。**両方に同じ zip** を付ける
- zip の名前は `Paramroom-v0.X.Y.zip`。中身は `Paramroom-unity-v0.X.Y.unitypackage`・`Paramroom.App.exe`・
  `LICENSE`・`THIRD-PARTY-NOTICES.txt`・`README.txt`（導入手順と「作り直しが要るか」）と、おまけの `ShotLink-v<版>/`
- **GitHub の Releases にも `THIRD-PARTY-NOTICES.txt` を毎回添付する**（exe に MIT のライブラリと
  .NET ランタイムが入っているので、表示を付けて配る義務がある。`THIRD-PARTY.md`）
- 版を出すたびに、**両方のバリエーションの zip を差し替え**、本文の版番号（同梱物・使用方法のファイル名）と「更新履歴」を直す（商品名には版番号を入れていない）。
  更新履歴にも「アバターの作り直しが要るか」を書く
- 差し替え・公開は**ユーザーが自分で行う**（外向きの操作）。こちらは zip と文面の用意まで
