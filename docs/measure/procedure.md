# 実機測定の手順

目的: シミュレーションの仮説チャネルモデル（docs/design/02 §1.1）と、パラメータ→シェーダー経路の前提（docs/research/06）を実機で確かめる。

役割分担
- **あなたにしかできないこと**: アカウント準備、Unity での配置とアップロード（VRChat ログインが必要）、VRChat クライアントの起動と操作、OBS 録画
- **こちらでやること**: 測定キット（作成・検証済み）、OSC 送信（同じ PC 上で実行）、録画の解析、チャネルモデルの更新と再評価

---

## 0. 測定キットの中身（検証済み）
| 場所 | 内容 | 事前検証 |
|---|---|---|
| `measure/unity/Assets/ImagePadMeasure/` | 測定ボード／カメラループのシェーダー、プレハブ生成スクリプト | Unity 2022.3.22f1＋SDK 3.10.4＋MA 1.17.1 の一時プロジェクトでコンパイル・生成・描画を確認。描画結果を解析ツールで復号し全項目一致 |
| `measure/osc/sender.js` | OSC 送信（Int パラメータ D0〜D31、保持時間・送り方を変えて送信しログ記録） | パケット生成式がシェーダーと一致（20 万件照合） |
| `measure/analysis/` | 録画の復号（`decode-video.js`）と集計（`analyze.js`） | 合成動画で欠落率が正解と完全一致 |

測定ボード（アバターの胸の前に表示）: マゼンタ枠＋左上シアン、8×12 マスの白黒で「受信した連番・モード・整合（半端パケット検出）・値の厳密性・IsLocal・IsOnFriendsList・全ゼロ・カメラループのカウンタ・epoch」を表示する。

---

## 1. 準備（あなたの作業）

### 1.1 アカウント
- **A**: 送信役。測定アバターをアップロードして着る。
- **B**: 受信役。**A とフレンド**にしておく。
- **C（任意）**: 非フレンド。カメラの可視条件（非フレンド／Show Avatar）の確認用。後日でも可。

### 1.2 Unity（測定アバターの作成）
1. Modular Avatar が入ったアバタープロジェクトを用意（例: 既存の `cleanTest` の複製）。**測定専用アバターとして別 Blueprint でアップロード**することを推奨（既存アバターを上書きしない。同じ Blueprint を複数人が着ると RenderTexture が共有される既知問題もある）。
2. リポジトリの `measure/unity/Assets/ImagePadMeasure` フォルダをプロジェクトの `Assets/` にコピー。
3. メニュー **Tools > ImagePad > Build Measurement Prefab (256 bit = 32 Int)** を実行 → `Assets/ImagePadMeasure/ImagePadMeasure.prefab` が生成される。
4. プレハブをアバターのルート直下に置く。ボードは胸の前（高さ 1.3m・前方 0.45m）に出る。見やすい位置に動かしてよい（回転は変えない）。
5. **同期パラメータ予算**: このプレハブは 256bit 全部（Int×32）を使う。アバター側に他の同期パラメータがあると超過してアップロードできない。
   - 超過する場合: 他のパラメータを減らす（MA Parameters で Synced を外す等）か、128bit 版（メニューの 16 Int 版）を使う。
6. SDK の Build & Test で表示を確認（任意）→ **Private でアップロード**。

### 1.3 VRChat の設定（A・B 両方のプロファイル）
- Settings > Debug > **Logging を「Errors Only」**（off だと追加クライアントが黒画面で止まる既知問題）。
- A のクライアントで **OSC を有効**（Action Menu > Options > OSC > Enabled）。B は無効。

### 1.4 2 クライアントの起動
同じ PC で 2 つ起動する場合（初回はそれぞれのプロファイルで A / B にログイン）:
```
"C:\Program Files (x86)\Steam\steamapps\common\VRChat\launch.exe" --profile=0 --no-vr --fps=60 --osc=9000:127.0.0.1:9001 -screen-width 960 -screen-height 540
"C:\Program Files (x86)\Steam\steamapps\common\VRChat\launch.exe" --profile=1 --no-vr --fps=60 --osc=9010:127.0.0.1:9011 -screen-width 960 -screen-height 540
```
- **`VRChat.exe` を直接起動すると「offline testing mode」になりオンラインのワールドに入れない**。必ず `launch.exe`（EAC 経由）から起動する。デスクトップのショートカット「VRChat 測定A/B/C」は設定済み。
- 起動は少し時間をずらす（EAC の多重起動エラー回避）。
- A が測定アバターを着る。B は別のアバター（測定アバターは着ない）。
- 人の少ないワールドの **Invite / Friends+ インスタンス**で合流。

### 1.5 見え方と OBS
- A: 自分の胸の前のボードが画面に映るよう下を向く（左右反転で見えても解析は対応済み）。
- B: A の正面 1〜2m に立ち、ボードが画面に大きく映るようにする。
- OBS: **1 つのシーンに A と B のウィンドウを並べて**キャプチャ。各ボードが 200px 以上で映ること。
  - 設定 > 映像 > FPS **60（固定）**、録画形式 mp4 または mkv、画質は高め（ボードの白黒が潰れなければよい）。

準備ができたら「準備完了」と伝えてください。ここから先の送信はこちらで実行します。

---

## 2. 測定の流れ（送信はこちらで実行、あなたは録画と操作）

各テストの前に OBS の録画を開始し、終わったら停止してファイルの場所を教えてください（1 テスト 1 ファイルでも、まとめて 1 ファイルでも可）。

| # | テスト | 所要 | 送信コマンド（こちらで実行） | あなたの操作 |
|---|---|---|---|---|
| T0 | 表示確認 | 1 分 | `node measure/osc/sender.js exact --count 10` | 両画面でボードが白黒で変化しているか確認 |
| T1 | 値の厳密性 | 2 分 | `node measure/osc/sender.js exact --hold 500 --count 120` | 静止 |
| T2 | 保持時間と欠落・同期間隔 | 約 7 分 | `node measure/osc/sender.js hold --holds 80,100,117,133,150,200,300,500 --count 150 --epoch 10` | 静止 |
| T3 | OSC バンドル送信（同時反映されるか） | 約 2 分 | `node measure/osc/sender.js hold --holds 100,150 --count 300 --bundle --epoch 30` | 静止 |
| T4 | 半端パケットの誘発（メッセージ間に遅延） | 約 2 分 | `node measure/osc/sender.js hold --holds 150 --count 400 --msgDelay 2 --epoch 40` | 静止 |
| T5 | 途中参加 | 約 5 分 | `node measure/osc/sender.js idle --hold 150 --epoch 50` | B がワールドから出て再参加 ×3 回（録画は続ける） |
| T6 | カリング | 約 5 分 | T5 と同じ送信 | B が後ろを向く 10 秒 ×3、距離を離す、表示人数制限で非表示にする、ミラー越しに見る |
| T7 | カメラループの可視条件 | 後日可 | T5 と同じ送信 | B（フレンド）で確認 → C（非フレンド）で確認 → C が Show Avatar（再読み込み） |

所要時間の目安は合計 30 分程度（準備を除く）。

---

## 3. 解析（こちらで実行）
```
cd measure/analysis
node decode-video.js <録画ファイル>
node analyze.js <録画ファイル>.decoded.csv ../logs/<送信ログ>.csv
```
得られる値: 保持時間ごとの欠落率、remote で新しいパケットが見える間隔の分布、local との遅延差、半端パケットの発生回数と持続フレーム数、値の厳密性、全ゼロの過渡表示、IsOnFriendsList、カメラループの動作。

これらでシミュレーションの取得間隔分布・欠落率・半端パケット率・カリングモデルを置き換え、方式比較を再評価する。
