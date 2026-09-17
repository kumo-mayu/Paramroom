# 調査報告 07: プリミティブ表現の符号化効率 — 文献調査（2D ガウシアン / ベクタ近似 / VQ / 無帰還の進行的符号化）

調査日: 2026-09-18
対象: 「自己完結 256bit パケット × 100ms 周期・無帰還ブロードキャスト・fragment shader デコーダ」という条件下で、**送信 1 bit あたりの画質**を現行の貪欲プリミティブ方式（回転楕円・ハードエッジ・アルファ over・58bit/図形）より上げられる表現・符号化があるか。

## 凡例（証拠タグ）
- **[事実]** 出典に明記されている数値・記述（URL 併記。本文/要旨/二次資料のどれを読んだかも併記）
- **[推測]** 文献と本件条件からの推論。実測なし
- **[未確認]** 妥当そうだが出典も実測も無い

---

## 0. 先に要約表

| 技術 | 期待できる改善（bit あたり画質） | shader での復号コスト | 制約との相性 | 主な出典 |
|---|---|---|---|---|
| **A. ソフト核（2D ガウシアン）＋順序独立ブレンド** | **大（>30%）[推測]**。ただし +0.8dB のブレンド分だけは [事実] | 現行比 **1.0〜1.3 倍**。`exp` 1 命令、または多項式核で同等以下 | ◎ 順序依存が消えるので冪等性・任意順適用が**逆に強くなる**。bit 数は現行と同じ 58bit で組める | GaussianImage (ECCV'24) / Image-GS (SIGGRAPH'25) |
| **B. 送信側の同時最適化（微分可能ラスタライザ＋量子化考慮学習）** | **大（>30%）[推測]** | **ゼロ**（符号化器のみ変更） | ◎ 制約に一切触れない。最優先で試すべき | fogleman/primitive の貪欲性 [事実] / LIVE・DiffVG / GaussianImage++ |
| **C. 固定レート VQ（形状・色のコードブック）** | **中〜大（15〜35%）**。同系統で **bpp −20%** の [事実] あり | 小テクスチャ 1〜2 回の fetch。可変長ではない | ○ 汎用コードブック（シェーダ内蔵）なら完全自己完結。画像適応パレットは別パケットが必要（epoch で保護、到着後に自己修復） | CGVQ (arXiv 2607.05667) / Lookabaugh & Gray 1989 |
| **D. 低解像度ベース層＋プリミティブを残差に** | 最初の数秒に**大**、定常では小 [推測] | 小（1 テクスチャ加算） | ○ 報告 05 §3.4 の ThumbHash 型と同じ。加算ブレンド（A）と相性が良い | 報告 05 / Image-GS の LoD 階層 [事実] |
| **E. パケット内エントロピー符号（静的 Huffman / rANS）** | **小（<10%）**、しかも実装危険 | 中〜大（逐次ビットパーサ＋可変長表）。rANS は終端状態の送出で 250bit 中 ~32bit を失う | △〜× 図形数が可変になりユニット ID → texel アドレスの対応が壊れる | ryg_rans / GaussianImage の ANS は CPU 側 [事実] |
| **F. Fountain/LT/Raptor, PET, MDC** | **改善なし（むしろ悪化）** | 事実上**不可能**（ガウス消去・BP 復号） | × k 個揃うまで何も出せない＝進行的描画と正面衝突。損失 ~0% では純損 | RFC 6330 [事実] / Albanese et al. 1996 |
| **G. Diffusion curves / gradient mesh** | 表現力は高いが | **不可能**（Poisson 方程式の大域反復解） | × 自己完結パケットにできない | Orzan et al. SIGGRAPH 2008 [事実] |
| **H. ベジエ/ストローク系プリミティブ** | 不明〜小 | **大**（3 次曲線までの距離＝反復求根） | △ 描画コスト制約に抵触 | Bézier Splatting (arXiv 2503.16424) |
| **I. INR / 学習型・拡散型の極低レート符号** | RD は最強クラスだが | **不可能**（MLP/拡散モデル） | × 全部揃わないと何も出ない | COIN / DiffEIC 等 |

**結論の一行**: 有望なのは **B（符号化器の同時最適化）→ A（ソフト核＋加算/正規化ブレンド）→ C（固定レート VQ）→ D（ベース層）** の順。E 以降は採らない。

---

## 1. 現行方式の数値的な位置づけ（比較の土台）

- 1 パケット 256bit / 100ms → **2560 bit/s = 320 byte/s**、図形 **40 個/秒**。
- 512×512 = 262,144 px。ペイロードのみで数えると **58bit × 4000 = 232,000 bit = 0.885 bpp**（ヘッダ込みで約 0.98 bpp）。
- 経過時間 → レート: **10 秒 ≈ 0.089 bpp**（400 図形）、**30 秒 ≈ 0.27 bpp**、**60 秒 ≈ 0.53 bpp**、**100 秒 ≈ 0.885 bpp**。
- つまり本件が戦う領域は **0.05〜0.9 bpp**、特に体験を決めるのは **0.05〜0.3 bpp** の極低レート帯。文献の 2D ガウシアン系画像圧縮がちょうど狙っている帯域と一致する。

文献側の参照点 [事実]:

| 手法 | レート | 品質 | データ | 出典 |
|---|---|---|---|---|
| 2D Gaussian Splatting for Image Compression | 0.042〜0.183 bpp | 低レートで **JPEG を上回る**（学習型 SOTA には届かない） | Kodak | APSIPA TSIP 13(6) |
| Image-GS | 0.122 bpp | PSNR **29.20**, MS-SSIM **0.924**, LPIPS 0.173 | 同論文のデータセット（スタイライズ画像中心） | arXiv 2407.01866 |
| Image-GS | 0.366 bpp | PSNR **32.99**, MS-SSIM **0.966** | 同上 | 同上 |
| GaussianImage (圧縮版) | 0.32 bpp | PSNR **25.66** | Kodak | arXiv 2403.08551 |
| JPEG2000（同論文中の比較） | 0.24 bpp | PSNR **27.28** | Kodak | 同上 |

> **懐疑的な注記 [事実＋推測]**: GaussianImage は 0.32 bpp で 25.66 dB であり、**同論文中の JPEG2000（0.24bpp で 27.28 dB）に 2〜3 dB 負けている**。つまり「2D ガウシアンスプラッティングはウェーブレットより RD が良い」わけでは**ない**。2D GS の売りは RD ではなく **(i) 復号が per-pixel 独立で超高速（~2000 FPS）、(ii) ランダムアクセス可能、(iii) パラメータが完全に独立した小さなレコード**という点。これは本件の shader 制約・パケット独立性の要求と一致するので、**「RD 最適だから採る」のではなく「shader で成立する表現クラスの中で最良候補だから採る」**という位置づけにすべき。報告 05 で wavl（ウェーブレット）が prim を上回っていた実測とも整合する。
> Image-GS の数字（0.122bpp で MS-SSIM 0.924）は魅力的だが、**データセットがスタイライズ画像中心**で Kodak のような写真ではない。写真に外挿するのは危険 [未確認]。

---

## 2. A: ソフト核（2D ガウシアン）＋順序独立ブレンド

### (a) 何をどれだけの bit で符号化するか

GaussianImage の 2D ガウシアンは **8 パラメータ**: 位置 μ∈R²、共分散（Cholesky 分解 l1,l2,l3）、重み付き色係数 c'∈R³。「our upgraded 2D Gaussian is described by only 3 attributes … with a total of 8 parameters」[事実・本文]。
圧縮版の量子化は [事実・本文]: 位置 = **16bit float ×2 = 32bit**、共分散 = **6bit 非対称整数 ×3 = 18bit**、色 = **Residual VQ（コードブック B=8、段数 M=2）**。
→ **合計およそ 32+18+6 = 56 bit/ガウシアン**。

**これは現行の 58 bit/図形とほぼ同じ**。つまり A は「bit 数を変えずに核と合成則だけ差し替える」案として成立する:

| フィールド | 現行（ハード楕円） | A 案（ガウシアン）例 |
|---|---|---|
| 位置 | 9+9 = 18 | 9+9 = 18 |
| 形状 | 半径 8+8 + 角度 6 = 22 | scale 8+8 + rot 6 = 22（または Cholesky 3×7=21） |
| 色 | RGB565 = 16 | **符号付き** 重み付き色 6+6+6 = 18 |
| α | 2 | 不要（色の大きさに吸収） |
| 計 | **58** | **58** |

APSIPA 版は 9 パラメータ（位置・異方共分散・色・不透明度）、位置は経験的に 10bit [事実・本文]。Image-GS は 8 パラメータ（μ, θ, s∈R²₊, c∈R³）[事実・二次資料 learnopencv]。

### (b) 主張されている品質

- **GaussianImage の ablation [事実・本文]**: 累積和ブレンド（accumulated blending）を使うと **38.69 dB vs アルファブレンド 37.89 dB = +0.8 dB**（Kodak, 30000 ガウシアン, 50000 step）。同時に「eliminates effects of random ordering」と明記。
- **Image-GS [事実・二次資料]**: 「At ultra-low bitrates, Image-GS even beats JPEG in many cases」。JPEG 圧縮画像 6 枚に対し平均 **+0.354 dB PSNR / +0.012 MS-SSIM**。
- **ハードエッジ楕円との直接比較は見つからなかった [未確認]**。差分可能ラスタライザ diffvg は hard-edged ellipse プリミティブを持ち、「what smooth falloff buys over original hard-edged primitives」を測ろうとしている学生リポジトリ（NSERC 2026）は見つかったが、結果は未公開。

### (c) fragment shader での復号

現行のハード楕円テスト: 画素を図形ローカル座標に変換（回転＋スケール、~6 ALU）→ `q = x²/a² + y²/b²` → `step(q, 1)`。
ガウシアン: **まったく同じ q を計算して `w = exp(-0.5*q)` にするだけ**。追加は SFU 1 命令。

- 512² × 32 図形/パス = 8.39 M 回/フレームの `exp` 追加。既存 ALU コストの数分の一なので **1.0〜1.3 倍** [推測]。
- `exp` を避けたい場合、**コンパクト台の多項式核**（例 `w = max(0, 1-q)²`）で置換できる。「From ex(p) to poly: Gaussian Splatting with Polynomial Kernels」(arXiv 2603.18707) がこの置換を扱っている [事実・要旨レベル、数値は PDF から抽出できず 未確認]。多項式核は **2 ALU で済みかつ台がコンパクト**なので、早期打ち切りも可能。
- **重要な利点**: ガウシアンの台は理論上無限だが、本件のレンダラは**元々 1 図形につきキャンバス全画素を走査している**ので、台が無限でも追加コストがゼロ。3D GS のタイル分割・ソートが不要。
- 合成則は 2 種類:
  1. **単純加算（GaussianImage 方式）**: `C = Σ c'_n · w_n`。RGB 1 枚のキャンバスに加算するだけ。最も安い。色は**符号付き**にする必要あり（暗くする図形を表現するため）→ キャンバスは HDR（RGBAHalf 等）が必要 [推測: Unity RT フォーマットの要件]。
  2. **正規化加算（Image-GS 方式）**: 「evaluates and ranks the density values … keeps the top-K and uses their density values as weights … normalized before aggregation」[事実・二次資料]。shader では **RGBA キャンバスに (c·w, w) を加算し、表示時に RGB/A で割る**だけで実装できる（top-K 選択は諦めて全図形を使う）。1 チャネル増えるだけでコストはほぼ同じ。背景の穴が埋まる利点がある一方、top-K の正則化効果は失われる [推測]。

### (d) 独立性・冪等性との相互作用 — ここが最大の利点

- 現行のアルファ over は**順序依存**。したがって「ユニット ID 順に描く」必要があり、また途中参加者が持っている部分集合は「穴の空いた合成」になる。
- 加算／正規化加算は**順序独立（permutation invariant）**。GaussianImage が明示的にそう言っている [事実]。
- 冪等性: パラメータは **ユニット ID → texel アドレス**で格納されるので、同じパケットが重複到着しても同じ texel を同じ値で上書きするだけ。**加算合成でも二重加算は起きない**（加算するのは毎フレームの再描画ループであって、受信時ではない）。
- 部分集合到着時の見え方: 加算の部分和は「まだ足されていない図形のぶんだけ薄い」＝**均一に薄い/低コントラストな画像**になり、アルファ over の「穴あき・重なり順崩れ」より素直に劣化する [推測]。正規化加算ならさらに素直（重みが無い場所は背景色）。
- 報告 05 §3.2 の「全ゼロ偽パケット」問題: 加算方式では ID 0 のユニットがゼロになっても**寄与がゼロになるだけ**（色 0・重み 0）で、ハードエッジのように大きな黒い楕円が現れない。**報告 06 §3.2 で prim 256 が 0.9754→0.8813 に落ちた劣化が、構造的に小さくなる** [推測]。

### (e) 改善見込み

**大（>30%）[推測]**。根拠:
1. ブレンド則の変更だけで +0.8 dB [事実]。
2. ハードエッジ楕円は 1 図形で「平坦な色パッチ」しか作れないのに対し、ガウシアンは 1 図形で**勾配**を作れる。写真のなだらかな領域を埋めるのに必要な図形数が減る [推測]。
3. ハードエッジは全域に偽輪郭を作り、MS-SSIM/知覚指標を強く損なう [推測]。本件は MS-SSIM で評価しているので効きやすい。

**ただし未検証**。既存の sim ハーネス（`sim/`）で「prim（現行）」対「prim-soft（核と合成則だけ差し替え、bit 配分は同一）」を回せば 1 日で決着がつく。**これを最優先の実験にすべき。**

リスク:
- 符号付き色と HDR キャンバスが必要 → VRChat アバターの RT/カメラループ制約を要確認 [未確認]。
- 加算のみだと「上に不透明に塗り重ねる」ができないため、シャープなエッジ（文字・ロゴ）は苦手になる可能性 [推測]。用途（何を送るか）によっては現行のほうが良い場面がある。ハイブリッド（α=3 のとき従来の over、それ以外は加算）は順序依存を戻すので**推奨しない**。

---

## 3. B: 送信側の同時最適化（微分可能ラスタライザ ＋ 量子化考慮）

### (a) 何を変えるか
表現もビット割当ても**一切変えない**。パラメータの決め方だけ変える。

現行（fogleman/primitive 系）は完全な貪欲法である [事実・公式 README]:
> 「Once we have found a good-scoring shape, we add it to the `Current Image`, where it will remain unchanged. Then we start the process again to find the next shape to draw.」
> 最適化は「hill climbing」＋複数のランダム初期形状。色は「directly computed, not optimized for」。

つまり **(i) 既配置図形は二度と再最適化されない、(ii) 各図形は山登りで局所最適、(iii) 色は閉形式で決め打ち、(iv) 量子化は考慮されない**。

### (b) 期待される利得の根拠
- **LIVE (CVPR 2022) vs DiffVG** [事実・プロジェクトページ]: DiffVG は「with only 5 paths … cannot reconstruct the input」だが 256 パスまで増やせば再構成できる。LIVE は**初期化と段階的追加を工夫して 5 パスで再構成**。初期化・割当の戦略だけで**必要プリミティブ数が桁で変わる**ことを示している。
- **Image-GS** [事実・要旨]: 「error-guided progressive optimization」により「naturally constructs a smooth level-of-detail hierarchy」。**段階的割当と同時最適化は両立できる**という直接の証拠。
- **GaussianImage++ (AAAI 2026, arXiv 2512.19108)** [事実・要旨]: 「distortion-driven densification」「attribute-separated learnable scalar quantizers」「quantization-aware training」で GaussianImage と COIN を上回る。→ **量子化考慮学習（QAT）**が効くことの証拠。
- 3D/2D GS 系は全て Adam による全パラメータ同時最適化で、貪欲法は使っていない。

### (c) shader コスト
**ゼロ**。フォーマットは変わらない。

### (d) 独立性・冪等性
影響なし。ただし **1 点だけ緊張がある**: 全 4000 図形を同時最適化すると、**先頭 N 個だけを描いた部分画像が最適でなくなる**（貪欲法は定義上どの前置も貪欲最適）。本件は「最初の数秒」が重要なので、これは致命的になりうる。

**解: 入れ子（段階凍結）最適化 [推測、Image-GS の progressive optimization に倣う]**
1. 最初の 100 図形を同時最適化 → 凍結
2. 次の 300 図形を追加し、**新規分のみ**同時最適化（凍結分は残差の定義に使う）→ 凍結
3. 以降 800 / 1600 / 4000 …と倍々でブレークポイントを置く

こうすると **ブレークポイント（≈2.5s / 10s / 20s / 40s / 100s）では前置最適**になり、その間は貪欲法と同程度。凍結分も緩く再最適化する変種（既存 texel は上書きで冪等なので、**同一ユニット ID の値を後から改善版に差し替えるのは合法**）も可能だが、エポック管理が要る。

さらに **QAT**: 量子化格子（位置 9bit、半径の `((q+1)/256)²` コンパンディング、RGB565）を最適化ループに入れる（straight-through estimator）。現行は連続値で最適化してから丸めているはずで、特に**半径の非線形コンパンディングは大半径側の刻みが粗い**ため丸め損失が大きい [推測]。

### (e) 改善見込み
**大（>30%）[推測]**、かつ **shader を一切触らない・制約リスクゼロ・sim で即検証可能**。
**費用対効果が最も良い。最優先。**

---

## 4. C: プリミティブパラメータのベクトル量子化 / コードブック

### (a) 何を符号化するか
固定長フィールドを、オフライン学習済みコードブックへの**固定長インデックス**に置き換える。

| 対象 | 現行 | VQ 案 | 節約 |
|---|---|---|---|
| 形状 (rx, ry, θ) | 8+8+6 = **22bit** | 4096 エントリの汎用コードブック = **12bit** | **10bit** |
| 色 (RGB565+α) | 16+2 = **18bit** | 画像適応 256 色パレット = **8bit** | **10bit** |
| 位置 | 18bit | VQ しない（一様分布に近く利得が小さい） | 0 |

合計 58 → **38bit/図形**。同じ帯域で **1 秒あたり 40 → 61 図形（+53%）**。ただしコードブックの歪みで 1 図形あたりの表現力は落ちるので、正味は下がる。

### (b) 文献の裏づけ
- **CGVQ (arXiv 2607.05667)** [事実・本文]: 2D ガウシアンのパラメータをクラスタごとの 3 種コードブック（位置=16bit FP、rotation-scale=UQ コードブック、色=RQ コードブック）で量子化し、GaussianImage ベースラインに対し **bpp を 20% 削減**（例: PSNR 31.0 dB で 1.92 bpp vs 2.40 bpp）。復号は「each compressed cluster is decoded independently by looking up its three dedicated codebooks」＝**ルックアップのみ** [事実]。
- **GaussianImage** 自体が色に **Residual VQ（B=8, M=2）** を使っている [事実]。
- **理論**: VQ の SQ に対する利得は memory gain / shape gain / space-filling gain に分解される（Lookabaugh & Gray, IEEE T-IT 1989）。**space-filling gain は次元によらず最大 1.53 dB（= 0.254 bit/次元）** [事実・二次資料]。
  → 3 次元をまとめても space-filling だけなら約 0.76bit しか得しない。**利得の本体は memory gain（(rx,ry,θ) の相関、色 3 チャネルの相関）と shape gain（実際の分布の偏り）**。したがって **「実データで学習したコードブックであること」が本質**で、理論上限だけ見て過小評価してはいけない。
  → 逆に言えば、**現行の半径の `((q+1)/256)²` コンパンディングは既に shape gain の一部を回収済み**なので、上積みは CGVQ の 20% 前後が現実的な期待値 [推測]。

### (c) shader での復号
- コードブックを **小テクスチャ**（例: 64×64 RGBA = 4096 エントリ × 4 成分）としてマテリアルに焼き込む。
- デコード = `tex.Load(int3(idx & 63, idx >> 6, 0))` の **1 回の fetch**。「very simple table lookup」の範囲内。
- 固定長なのでビットパースは現行と同じ。
- 色パレットは 256×1 テクスチャ 1 枚。

### (d) 独立性・冪等性
- **汎用（シェーダ内蔵）コードブック**: 送信不要 → **完全に自己完結。制約に一切抵触しない。**
- **画像適応パレット**: 別途送る必要がある。256 色 × 16bit = 4096bit = **16 パケット ≒ 1.6 秒**。
  - 対応: パレットパケットを予約種別にし、報告 05 §3.1 の Broadcast Disks／平方根則に従って**高頻度で再送**する。
  - **重要な良い性質**: 図形 texel に入るのは**インデックス**なので、パレットが未着でも図形は正しく蓄積される。**パレット到着の瞬間にキャンバス全体が一斉に正しい色になる（自己修復）**。途中参加者は最大 1 巡ぶん色がおかしいだけ。
  - 誤ったパレットの混入対策として epoch を共有する。報告 06 §3.2 の「全ゼロ偽パケット」に対しては、パレットも epoch=0 を無効として捨てる。
  - リスク: 色数 256 では写真のグラデーションにバンディングが出る [推測]。**加算ブレンド（A 案）と組むとパレット色が「加算する差分色」になるため、256 エントリでも見た目の色数は組み合わせで増える** [推測]。相性が良い。

### (e) 改善見込み
**中〜大（15〜35%）**。CGVQ の **−20% bpp** が最も近い実測 [事実]。汎用コードブックのみなら控えめ（10〜15%）、画像適応パレットまで入れれば 25〜35% [推測]。
実装コストは shader 側 1 fetch、送信側はコードブック学習（k-means / RVQ）。**B の次に着手すべき。**

---

## 5. D: 低解像度ベース層 ＋ プリミティブを残差に

報告 05 §3.4 の「途中参加者向けの小型 DCT プレースホルダ（ThumbHash/BlurHash 型）」と同じ案だが、**A 案（符号付き加算ブレンド）と組み合わせると設計が素直になる**ので再掲する。

- (a) 16×16 の DC 画像（ThumbHash 相当）を数十パケットで送り、以後のプリミティブは**その上に加算される符号付き残差**とみなす。
- (b) [推測] 定常状態の RD はほぼ変わらない（低周波はプリミティブでも安く表現できる）が、**最初の 3〜5 秒の体感は大きく変わる**。Image-GS が「error-guided progressive optimization → smooth level-of-detail hierarchy」を作っている [事実] のと同じ発想。
- (c) shader: ベーステクスチャを 1 回サンプルして初期値にするだけ。コストほぼゼロ。
- (d) ベース層パケットは自己完結（サブブロック ID + 係数）。未着時はフラット背景に退化するだけで冪等。
- (e) **定常では小、最初の数秒では大** [推測]。

---

## 6. E: 250bit パケット内のエントロピー符号 — 採らない理由

### (a) 何ができるか
現行 244bit 使用（epoch 2 + unit id 10 + 58×4）、**12bit の余り**がある。静的 Huffman を各フィールドに当てれば、平均符号長を 58 → 50bit 程度に下げられる可能性がある [推測]。→ 1 パケットに 4.6 図形。

### (b)〜(c) 実際のコストと障害
1. **rANS は終端状態を書き出す必要がある**（ryg_rans 実装参照）。典型的な 32bit 状態を 250bit のペイロードに載せると **約 13% を固定オーバヘッドで失う**。パケット独立＝毎パケットで状態をリセットする以上、これは回避不能。**小ペイロードでは ANS は不利**。
2. **算術符号**なら終端は数 bit で済むが、shader で逐次除算・区間更新を 4〜5 シンボル分回すことになる。
3. **静的 Huffman** が唯一現実的。canonical Huffman なら 16〜32 エントリの定数配列で復号できる（「very simple」の境界線上）。しかし:
4. **致命的な副作用**: 1 パケットあたりの図形数が可変になると、**「パケット i の図形は texel 4i〜4i+3」という自明なアドレス対応が壊れる**。可変長の累積位置はグローバル状態であり、パケット独立性と真っ向から衝突する。
   - 回避策は「図形数は 4 に固定し、浮いた bit を精度向上に回す」だが、その場合の利得は「bit あたりの図形数」ではなく「図形あたりの精度」になり、効果はずっと小さい [推測]。
5. GaussianImage も ANS（partial bits-back coding）を使っているが、これは **CPU 側のコーデック**であって、レンダリング（2000 FPS）は量子化済みパラメータに対して行われる [事実]。**GPU で ANS を直接復号する構成は文献にも無い**（Recoil / DietGPU のような GPU rANS は「多数の独立パーティション」に分割して並列化しており、逐次性が本質的な制約であることを認めている [事実・要旨]）。

### (e) 改善見込み
**小（<10%）かつ高リスク**。
**代替**: 求めているのは「固定長フィールドの冗長性を削る」ことであり、それは **C の固定レート VQ が shader フレンドリーに達成する**。エントロピー符号は追わない。

---

## 7. F: Fountain / LT / Raptor / PET / MDC — 明確に不採用

### 事実
- **RaptorQ (RFC 6330)**: 「if the reception overhead is 0, 1 or 2 symbols, then the decode failure probability is 0.01, 0.0001, and 0.000001」[事実]。k の全範囲で成立。オーバヘッド自体は極めて小さい。
- **LT 単体**は小ブロックで「tail problem」により効率が落ちる。標準 Raptor の推奨 k は 1024〜8192 で、**BP 復号は k が数万規模でないと性能が落ちる**ため inactivation decoding（＝ガウス消去の併用）が必要 [事実・二次資料]。
- **PET (Albanese, Blomer, Edmonds, Luby, Sudan, IEEE T-IT 1996)**: 各シンボルに優先度を与え「minimal number of codeword symbols required to recover that symbol」を決める [事実]。

### なぜ本件では損か
1. **損失が実測 ~0%**。FEC は冗長度を足すだけで、画質に使える bit を確実に減らす。期待利得が負。
2. **k 個揃うまで何も復号できない**。本件の価値の中心は「受信した分だけ絵が濃くなる」進行的描画。ファウンテン符号はこれを破壊する。PET/MDC は階層ごとに部分復号できるが、それでも「各階層について k_i 個」が必要。
3. **shader で復号できない**。BP/inactivation はワークリストと可変長の状態を持つ逐次アルゴリズム。fragment shader に持ち込めない。
4. **現行のカルーセルは既に最適に近い**。k 個の自己完結パケットを**巡回**送信する場合、全部集めるのに必要なのはちょうど k 受信（ランダム抽出なら coupon collector で k ln k 必要だが、巡回なので k）。RaptorQ は k+2 受信＋線形代数を要する。**符号化率 1 の巡回送信は、損失 0 の環境では厳密に優れている。**
5. 唯一の適用場面は「大きなバースト損失があり、かつ k が大きい」場合。報告 05 §3.5 の結論と同じ。

**→ 受信側からのフィードバックを要するもの（ARQ, rate adaptation）も同様に対象外。本報告では一切推奨しない。**

---

## 8. G〜I: 魅力的に見えるが制約を破るもの

### G. Diffusion curves / gradient mesh
- Orzan et al., SIGGRAPH 2008 [事実]: 「The final image is constructed by solving a Poisson equation whose constraints are specified by the set of gradients across all diffusion curves.」表現は非常にコンパクトで解像度非依存。
- **不可**: (i) 復号が**大域的な Poisson 解法**（多重格子 or 反復）で、per-pixel の独立ループでは書けない。(ii) 1 本の曲線を足すと**画像全体が変わる**ので「各パケットが独立に意味を持つ」性質が消える。(iii) 途中欠落した曲線があると拡散の境界条件が壊れ、**局所的な欠損では済まない**。
- Gradient mesh も同様（連結メッシュ前提で、パケット独立と両立しない）。

### H. ベジエ／ストローク系プリミティブ
- Bézier Splatting (arXiv 2503.16424) [事実・要旨]: ベジエ曲線に沿って 2D ガウシアンをサンプリングする。DiffVG 比で forward 30×, backward 150× 高速。SVG に変換可能。
- 「Emergence of Painting Ability via Recognition-Driven Evolution」(arXiv 2501.04966) の **0.059 bpp が JPEG 0.433 bpp に匹敵**という主張 [事実・本文] は、**CLIP ゼロショット分類精度（74.51% vs 79.10%）で測ったもの**であり、**PSNR や知覚忠実度ではない**。著者自身「compresses images by vector representations with high abstraction levels and extremely restricted colour richness … maintaining recognition accuracy」と述べている。**本件（見た目の忠実度が目的）には転用できない。数字に惑わされないこと。**
- **shader コスト**: 3 次ベジエまでの距離は反復求根（または複数のガウシアン展開）が必要で、1 プリミティブあたりのコストが 1 桁上がる。「ベジエに沿ったガウシアン列」にすると、1 プリミティブ = 複数ガウシアンなので bit 効率は上がりうるが、per-pixel コストも比例して上がる。**現行の描画コスト制約（~32 図形/パス）と相性が悪い。**
- 例外的に安いのは「線分＋太さ」（カプセル）。距離計算は閉形式で 10 ALU 程度。細長い構造（髪・輪郭）が多い画像なら楕円より効率的な可能性 [未確認]。低優先で検討に値する。

### I. INR / 学習型 / 拡散型
- COIN, DiffEIC（<0.1 bpp）など極低レートの SOTA は全て**ニューラルデコーダ**。fragment shader に MLP は載らない（重みの転送量も論外）。**全パラメータが揃わないと何も出ない**ので途中参加とも両立しない。**対象外。**

---

## 9. 「累積的に描くデコーダ」向けの符号化について（質問 5 への回答）

- **専用の文献は見つからなかった [未確認]**。stroke-based rendering (Hertzmann のコース資料, SIGGRAPH 2002) は「限られたストローク数で絵を作る」問題を扱うが、**通信路の話はしていない**。
- 最も近いのは **Rosenbaum & Schumann, "Progressive imagery with scalable vector graphics" (SPIE EI 2011)** [事実・要旨]: SVG を skeleton と update element に分解して要素単位でストリーミングし、「Partially reconstructed streams remain compliant SVG files」。**部分受信が常に妥当な画像であること**を設計原理にしている点は本件と同じ。ただし TCP 前提で、欠落・順序入替は想定していない。
- したがって **本件の「自己完結パケット＋アドレス付き texel 格納＋順序独立合成」は、文献上のギャップに近い構成**。報告 05 の結論（骨格は既知手法の組合せ）と矛盾しないが、**「順序独立合成を採ることで進行的描画が数学的にきれいになる」点は、GaussianImage の accumulated blending を借りてくることで初めて成立する**。ここが本調査の一番の収穫。

---

## 10. 推奨する実験（優先順）

| # | 実験 | 変更範囲 | 検証コスト | 期待 |
|---|---|---|---|---|
| 1 | **prim の同時最適化版**（微分可能ラスタライザで全パラメータを Adam 最適化。段階凍結でブレークポイント前置最適を保つ。QAT 付き） | 送信側のみ | 中（diffvg or 自前の soft-rasterizer） | >30% [推測] |
| 2 | **prim-soft**: 核を `exp(-q/2)` または `max(0,1-q)²` に、合成を加算／正規化加算に。**bit 配分は 58bit のまま** | 送信側＋shader | 小（sim で先に判定可能） | >30% [推測] |
| 3 | **色パレット VQ**（256 色、パレットは予約パケットで高頻度再送）＋形状 VQ（汎用 4096 エントリ） | 送信側＋shader（fetch 1〜2 回） | 中 | 15〜35% [事実ベース: CGVQ −20%] |
| 4 | **ベース層**（16×16 DC、数十パケット）を最初に | 両側 | 小 | 最初の数秒に大 |
| 5 | カプセル（線分＋太さ）プリミティブの追加 | 両側 | 中 | 未確認 |

1 と 2 は**直交する**（1 は最適化、2 は表現）。両方入れると相乗効果が期待できる [推測]。
**まず 1 を単独で回して、貪欲法がどれだけ損をしていたかを測るのが最も情報量が多い。**

---

## 11. 主な出典（URL・日付）

すべて 2026-09-18 にアクセス。

1. Zhang et al., **GaussianImage: 1000 FPS Image Representation and Compression by 2D Gaussian Splatting**, ECCV 2024. arXiv:2403.08551 (2024-03-13, v5)
   https://arxiv.org/html/2403.08551v5 ／ https://arxiv.org/abs/2403.08551 ／ https://dl.acm.org/doi/10.1007/978-3-031-72673-6_18
   （8 パラメータ、位置 16bit float・共分散 6bit・色 RVQ(B=8,M=2)、累積和ブレンドで 38.69 vs 37.89 dB、Kodak 0.32bpp で 25.66 dB、~2000 FPS）
2. Zhang et al., **Image-GS: Content-Adaptive Image Representation via 2D Gaussians**, SIGGRAPH 2025. arXiv:2407.01866 (2024-07-02)
   https://arxiv.org/abs/2407.01866 ／ https://dl.acm.org/doi/10.1145/3721238.3730596 ／ https://github.com/NYU-ICL/image-gs
   （0.3K MACs/pixel、top-K 正規化ブレンド、error-guided progressive optimization で LoD 階層、0.122bpp で PSNR 29.20 / MS-SSIM 0.924）
   解説: https://learnopencv.com/image-gs-image-reconstruction-using-2d-gaussians/
3. **2D Gaussian Splatting for Image Compression**, APSIPA Transactions on Signal and Information Processing 13(6)
   https://www.emerald.com/atsip/article/13/6/1/1331414
   （9 パラメータ、位置 10bit、0.042〜0.183 bpp、低レートで JPEG 超え、アルファブレンド）
4. **Clustered Codebook Quantization for 2D Gaussian-based Image Compression (CGVQ)**, arXiv:2607.05667
   https://arxiv.org/html/2607.05667 （bpp −20%、復号はコードブックルックアップのみ）
5. **GaussianImage++: Boosted Image Representation and Compression with 2D Gaussian Splatting**, AAAI 2026. arXiv:2512.19108
   https://arxiv.org/abs/2512.19108 （attribute-separated learnable scalar quantizers ＋ QAT）
6. Ma et al., **Towards Layer-wise Image Vectorization (LIVE)**, CVPR 2022 Oral
   https://ma-xu.github.io/LIVE/ （DiffVG は 5 パスで再構成不能、256 パス必要。LIVE は 5 パスで可）
7. **Bézier Splatting for Fast and Differentiable Vector Graphics Rendering**, arXiv:2503.16424
   https://arxiv.org/abs/2503.16424
8. Orzan et al., **Diffusion Curves: A Vector Representation for Smooth-Shaded Images**, ACM TOG 27(3), SIGGRAPH 2008
   https://dl.acm.org/doi/10.1145/1360612.1360691 ／ https://maverick.inria.fr/Publications/2008/OBWBTS08/
9. **Emergence of Painting Ability via Recognition-Driven Evolution**, arXiv:2501.04966
   https://arxiv.org/html/2501.04966v1 （0.059bpp の主張は CLIP 分類精度 74.51% vs JPEG 79.10%。画素忠実度ではない）
10. fogleman/**primitive** — Reproducing images with geometric primitives
    https://github.com/fogleman/primitive （貪欲・山登り・既配置図形は不変・色は閉形式）
11. **RFC 6330: RaptorQ Forward Error Correction Scheme for Object Delivery** (2011-08)
    https://www.rfc-editor.org/rfc/rfc6330.html ／ Luby, ICNC 2012 slides: http://www.conf-icnc.org/2012/Raptor%20overview%20for%20ICNC%2030Jan2012%20distribute.pdf
    （overhead 0/1/2 シンボルで失敗確率 1e-2 / 1e-4 / 1e-6）
12. Albanese, Blomer, Edmonds, Luby, Sudan, **Priority Encoding Transmission**, IEEE Trans. Information Theory, 1996-11
13. Lookabaugh & Gray, **High-resolution quantization theory and the vector quantizer advantage**, IEEE Trans. IT, 1989-09
    （memory / shape / space-filling gain の分解。space-filling gain は最大 1.53 dB）
14. Rosenbaum & Schumann, **Progressive imagery with scalable vector graphics**, SPIE EI 2011
    https://vca.informatik.uni-rostock.de/~schumann/papers/2010+/Rosenbaum-EI11b.pdf
15. Hertzmann, **Stroke-Based Rendering**, SIGGRAPH 2002 course notes
    https://www.cs.ucdavis.edu/~ma/SIGGRAPH02/course23/notes/S02c23_3.pdf
16. Neff & Zakhor, **Very low bit-rate video coding based on matching pursuits**, IEEE TCSVT, 1997（加算的なアトム分解の古典。順序独立・自己完結アトムという点で A 案と同系統の発想）
17. **From ex(p) to poly: Gaussian Splatting with Polynomial Kernels**, arXiv:2603.18707
    https://arxiv.org/pdf/2603.18707 （exp を多項式核で置換。数値は本文から抽出できず [未確認]）
18. ryg_rans — https://github.com/rygorous/ryg_rans ／ Recoil: Parallel rANS Decoding, ICPP 2023, arXiv:2306.12141
    https://arxiv.org/abs/2306.12141 （rANS は本質的に逐次。GPU 並列化は独立パーティション分割に依存）

---

## 12. 報告 05 との関係

- 報告 05 の結論（「符号化そのものより送り方」）は**送り方の層**の話で、本報告は**表現の層**を見た。両立する。
- 報告 05 §3.7「シェーダー向き固定レート符号（学習済みコードブックの多段 VQ）」は、本報告 §4（C）で CGVQ という具体的な実測（bpp −20%）を得た。**優先度を上げてよい。**
- 報告 05 §3.5（消失訂正符号）の「採らない」結論は、本報告 §7 で RFC 6330 の具体値と「カルーセルは損失 0 で厳密に優る」という論拠で補強された。
- 報告 06 §3.2 の「全ゼロ偽パケット」による prim の大劣化（0.9754 → 0.8813）は、**加算ブレンド（A 案）にすると構造的に軽くなる**見込み [推測]。A 案の副次的な利点として評価に入れるべき。
