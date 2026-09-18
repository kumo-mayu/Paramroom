# ImagePad（アバターに入れる部品）

| 場所 | 中身 |
|---|---|
| `Editor/ImagePadPrimBuilder.cs` | **Tools/ImagePad/Prim Decoder Builder** のウィンドウ。形式と Int の数を選び、`Assets/ImagePad/ImagePadPrimDecoder*.prefab` を作る |
| `Editor/ImagePadModularAvatar.cs` | Modular Avatar のコンポーネントを付ける共通の処理（測定用のビルダーも使う） |
| `Shaders/ImagePadPrimDecoder.shader` | カメラループで図形を描き直すデコーダー |
| `Shaders/ImagePadPrimDisplay.shader` | 表示板（縦横比に合わせて形を変える） |

## 作れる形式

図形 1 個のビット数：標準は 58 bit、軽量は 47 bit（座標 8・半径 6・角度 5・色 444・α 2）。

| `ImagePad_Format` | 内容 | 選べる Int の数（1 周の時間、100 ms/パケット） |
|---|---|---|
| 3 | 512px・図形 4000 個・標準 | 10（400 s）/ 18（200 s）/ 25（133 s）/ 32（100 s） |
| 4 | 512px・図形 4000 個・軽量 | 9（400 s）/ 15（200 s）/ 21（133 s）/ 26（100 s）/ 32（80 s） |
| 5 | 512px・図形 5000 個・軽量 | 9（500 s）/ 15（250 s）/ 21（167 s）/ 27（125 s）/ 32（100 s） |
| 6 | **1024px**・図形 4000 個・標準（負荷測定用） | 11（400 s）/ 18（200 s）/ 25（133 s）/ 32（100 s） |

- **形式 1（256/1000）と 2（512/2000）**：もう作らない（2026-09-17）。既にそれを入れたアバターには、送信アプリ・センダーからそのまま送れる。
- **形式の比較**：`measure/results/2026-09-17/precision`、`comparison-4`、`measure/results/2026-09-18/repr`。

### 形式 6（1024px）について

1024 は「近づいて見たときに文字が読めるか」を上げるための候補（`docs/research/08-primitive-representation-experiments.md`）。
**まず VRChat での負荷を測るために用意したもの**で、採用は決めていない。

- 図形 1 個は **59 bit**（座標 10・半径 8・**角度 5**・色 565・α 2）。座標に 10 bit 要るので角度を 1 bit 削り、パケットに縦横比コード用の 8 bit を残している
- **アトラスが 2048x1044 になる**（512 のときは 1024x536）。ARGBHalf なので **1 枚 16.3 MB、2 枚で約 33 MB の VRAM**（512 は合計 9 MB）
- **1 パス（= 1 フレーム）の画素数が約 4 倍**になる。1 周（4000 図形）に要するパス数は 512 と同じ 125 なので、**フレーム当たりの負荷が 4 倍**という見積もり
- 重すぎる場合は、シェーダの `_BatchSize`（1 パスで描く図形数、既定 32）を下げてフレーム当たりを軽くし、その分 1 周にかかるフレーム数を増やせる

## 測定用の道具との分け方

同期の遅れや取りこぼしを測る表示板とそのビルダー、デコーダーの自動テスト（`ImagePadPrimTest`）とテストデータは `Assets/ImagePadMeasure` に置く。アバターに入れるのは `Assets/ImagePad` だけでよい。

## 前の配置（Assets/ImagePadMeasure に全部あった版）から移すとき

1. アバターのプロジェクトの `Assets/ImagePadMeasure` から、`Editor/ImagePadPrimBuilder.cs`、`Shaders/ImagePadPrimDecoder.shader`、`Shaders/ImagePadPrimDisplay.shader` を消す。残すと同じクラスやシェーダーが 2 つになり、コンパイルエラーやシェーダーの取り違えが起きる。
2. この `ImagePad` フォルダを `Assets/ImagePad` として入れる。
3. ビルダーでプレハブを作り直し、アバターの古い `ImagePadPrimDecoder*` と入れ替える。古いプレハブと `GeneratedPrim*` フォルダは、消したシェーダーを指しているので消してよい。
