---
paths:
  - "measure/unity/Assets/kumo-mayu/Paramroom/Shaders/**"
  - "measure/unity/Assets/kumo-mayu/Paramroom/Editor/**"
---

# 受信側（シェーダー・プレハブ生成を触るときに読み込まれる）

決め事の本体は CLAUDE.md の「作りの決め事」。経緯と試験の結果は `docs/research/10`。

- VRChat は OSC バンドルを 1 フレームで適用しきれないことがあり、前半が新しく後半が古い値が 1 フレームだけ見える（実測 0.3%）
- 半端な値はフレーム単位で見えるので「2 パス続けて同じ」では弾けない（同じフレームの 2 パスは同じ値を見る）
- カメラ A のパスだけが判定し、1 フレーム前に自分が見たバイト列と同じときだけ取り込む。B のパスは写すだけ
- 材料はマテリアルの `_Primary`（ビルダーが A に 1、B に 0 を書く）。両方 1 にすると半端パケットを取り込み、`shader-check` の maxdiff が 1 → 140 に跳ねる
- 形式を足すときは `ParamroomBuilder.Formats` と C# の `DecoderFormat.Known` の両方を直す。既存の形式番号と中身は変えない
