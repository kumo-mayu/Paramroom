# primitive 表現の比較画像（2026-09-18）

`docs/research/08-primitive-representation-experiments.md` の実験に対応する画像。
すべて 512 キャンバス・パケット 1001 個（= 現行 512/4000 と同じ通信量）で、「誤差削減の大きいパケットから順に
n 個届いた状態」を描いたもの。1 パケット 100 ms なので 20 パケット ≒ 2 秒。

- `kodim23-variants.png` / `screenshot_mahara-variants.png`: 現行(base)・軽量(light)・探索強化(deep)・
  輪郭ぼかし(softbase)・円(circ39)・加算合成(addhard) の比較。円の点状の粗さ、加算合成の霞んだ見えが分かる
- `screenshot_wikipedia-variants.png`: 最終候補（base / lightsoft / deepsoft / lightsoftdeep）の比較
- `illust_chibi-grid.png`: 「最初に粗い画像（低解像度グリッド）を送る案」と現行の比較。現行が序盤から優る

作り方: `node sim/shape-sheets.js <outDir> <image> <variants> <fracs>`、`node sim/grid-sheets.js <outDir> <image> <grids> <packets>`
