---
name: shader-check
description: 受信側（デコーダーのシェーダー・プレハブ生成）を Unity の batchmode で実際に動かして確かめる。measure/unity/Assets/ 以下を触ったとき、シェーダーを直したとき、「シェーダーを確かめて」と言われたときに使う。
---

# 受信側の確かめ

**コンパイルが通っただけで済ませない。** 受信側はカメラループの状態機械なので、
実際に回してみないと「取り込む／取り込まない」「描き直す／描き直さない」が分からない。

## 要るもの

Unity 2022.3.22f1 ＋ VRChat SDK ＋ Modular Avatar の入ったプロジェクト。
**このリポジトリには含まれない。** 作業用フォルダに一時プロジェクトを作って使う
（VCC で空のアバタープロジェクトを作り、そこへ写す）。一度作れば、そのセッションの間は使い回せる。

無ければユーザーに聞く。**勝手に既存のアバタープロジェクトを書き換えない。**

## 走らせ方

```bash
bash .claude/skills/shader-check/scripts/run-unity-test.sh <プロジェクト> shader prim-kodim23
bash .claude/skills/shader-check/scripts/run-unity-test.sh <プロジェクト> qr qronly-25x25-4int
bash .claude/skills/shader-check/scripts/run-unity-test.sh <プロジェクト> build
```

`measure/unity/Assets/` の中身をプロジェクトへ写してから走らせるので、**直した内容が必ず反映される**。
結果の行だけを出す（ログ全体は出さない）。Unity の場所は `PARAMROOM_UNITY` で変えられる。

| 試験 | 何を見るか | 通っている状態 |
|---|---|---|
| `shader` | 画像デコーダー。期待値（JS の参照描画）との差、**半端パケットを弾けているか**、再描画のアイドル判定、表示板の縦横比 | `maxdiff=1`、`present prims=1003/1003`、`counter=0 dirty=0` |
| `qr` | QR 専用デコーダー | 7 項目すべて OK |
| `build` | プレハブ生成（カメラ・far・マテリアルの値・Modular Avatar） | 44 項目すべて OK |

`shader` には `-paramroomHold N` を足せる。**1 パケットが何フレーム映るか**を変えられるので、
受信側のフレームレートの影響を測れる（100 ms 保持なら「相手の fps ÷ 10」フレーム）。

## 試験が効いているかを一度確かめる

**直したあとに通るだけでは足りない。** わざと壊して落ちることを見る。

例: `ParamroomShaderTest.cs` の `matB.SetFloat("_Primary", 0)` を `1` にすると、
半端パケットを取り込むようになり `maxdiff` が 1 → 140 に跳ねる。跳ねなければ試験が何も見ていない。
**確かめたら必ず元に戻す**（写しのプロジェクトではなくリポジトリを直してしまわないよう注意）。

## テストデータを作り直す

形式やパケットの詰め方を変えたら、期待値も作り直す。

```bash
cd sim
node export-prim-test.js kodim23              # 画像モード
node export-qronly-test.js "<文字列>" --bytes 4 # QR 専用
```

`measure/unity/Assets/ParamroomMeasure/TestData/` に JSON と期待値の PNG が出る。
