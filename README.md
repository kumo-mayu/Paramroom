# avatar-image-pad

VRChat アバターの同期パラメータ（最大 256bit）だけを使って、他プレイヤーに画像を送る仕組みの調査・設計・シミュレーション。

## 構成
- `docs/research/` 調査報告
  - `01-vrchat-parameters.md` Expression Parameters の仕様・同期・既存プロジェクト
  - `03-remote-testing.md` リモート側の動作を確認する方法
  - `04-related-osc-video.md` VRChat-OSC-Video の分析と比較
  - `05-literature-review.md` 既存研究との照合（再発明の確認・取り込める設計原理）
  - `06-parameter-to-shader-path.md` パラメータからシェーダーへ値を渡す経路
- `docs/design/02-transmission-schemes.md` 伝送方式の比較結果とビット予算別の推奨
- `sim/` Node.js シミュレータ（方式実装 `codecs/`、チャネルモデル `lib/transport.js`、評価 `run.js` / `summary.js`）
  - 生の評価結果（`sim/results/*.jsonl`）は巨大なためリポジトリに含めない（`node run.js ...` で再生成）
- `measure/` 実機測定キット（Unity 測定用プレハブ生成スクリプトとシェーダー、OSC 送信、動画解析）。手順は `docs/measure/procedure.md`

画像の出典とライセンスは `sim/images/SOURCES.txt`。
