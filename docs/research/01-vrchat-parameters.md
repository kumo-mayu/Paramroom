# 調査報告 01: VRChat Avatar Parameters と画像送信ギミックの前提条件

調査日: 2026-09-17（VRChat live build 2026.3.2p2 / SDK com.vrchat.avatars 3.10.5 時点）

## 凡例

| タグ | 意味 |
|---|---|
| **[公式]** | VRChat が書いた資料（creators.vrchat.com / docs.vrchat.com リリースノート / SDK コード / スタッフ発言） |
| **[コミュ主張]** | 公式でない記述。測定根拠なし（コード定数・経験則・解説記事） |
| **[コミュ実測]** | 公式でない実測報告（方法が不明なものは明記） |
| **[推測]** | 本調査での推論。未検証 |
| **[未確認]** | 資料が見つからない。実験が必要 |
| ✔ | メイン agent が原文を直接取得して文言を確認済み（それ以外はsubagent経由の引用で、原文照合していない） |

---

## 0. 要点（先に結論）

1. **同期枠は 256 bit（int/float=8bit, bool=1bit）** [公式✔]。2021年に 128bit、2022.2.1 で 256bit に倍増、以降 2026 年まで変化なし。
2. **同期頻度の公式記述は「Playable: 0.1〜1秒ごと、変化に応じて（1〜10回/秒）。高速同期には頼るな」「IK: 0.1秒ごと継続（10回/秒）、floatはremoteで補間」** [公式✔]。カスタムパラメータは通常 Playable、Puppet 操作中のみ IK。OSC から駆動した場合どちらになるかは**文書化されていない** [未確認]。
3. **「10Hzで変更できる」≠「256bit×10回/秒の独立情報が届く」**。資料・実例から読み取れる伝送モデルは **「送信側が約0.1秒ごと（ジッタあり）に全パラメータのスナップショットを取り、最後の値だけが届く（last-value-wins のサンプリング）」** であり、変更イベントのキューではない。
   - 256bit 全体が1つのスナップショットとして原子的に送られる、という VRChat 開発者（Merlin）の Discord 発言がある [コミュ主張✔：二次資料経由]。
   - 実運用のプロジェクトは 1 パケットの保持時間を **0.1秒+1フレーム（VRCFury）〜 0.14秒（損失ほぼ無し）〜 0.2秒（損失無し、VRCBitmapLed）〜 0.25秒（KAT）** に設定している [コミュ実測/主張✔一部]。
   - VRCBitmapLed の損失表: 100ms=損失大 / 120ms=約5パケットに1回損失 / 130ms=約7に1回 / 140ms=まれ / 200ms=無し [コミュ実測✔、測定方法記載なし]。
   - よって**実効スループットの素朴な上限は 256bit/0.1s = 2.56 kbit/s だが、損失ほぼゼロで運用するなら 256bit/0.14〜0.2s ≒ 1.3〜1.8 kbit/s が現実的な出発点** [推測]。これは実測で詰めるべき最重要値。
4. **確認応答（ack）の経路は存在しない**。既存の「パラメータでデータを送る」系はすべてオープンループで、「アドレス付きパケット＋全データの周期的再送（カルーセル）」で損失と late join を吸収している [コミュ主張✔]。
5. **⚠ 構想の前提に関わる重大な制約: アバター上の Camera は remote では「フレンド」か「Show Avatar を押した人」にしか動かない。Quest/Android ではアバターの Camera もカスタムシェーダーも完全に無効** [公式✔]。
   - つまり RenderTexture カメラループ方式は **PC かつフレンド（または明示的に Show Avatar した相手）限定**。「VRC+ の print を無料で代替して複数人で見る」という目的に対しては、見られる相手がかなり限定される。
   - カメラを使わない代替（remote の Animator のローカル（非同期）パラメータをバッファにしてマテリアルへ流す方式）は存在する（VRCBitmapLed がこの方式）。ただしバッファ容量・描画負荷に制約がある。§6 参照。
6. 同じアバター（同一 blueprint ID）を複数人が着ると、**RenderTexture アセットを共有してしまい壊れる**という報告がある（2019年 Canny、pema99 のガイド）[コミュ主張✔、最近の確認なし]。
7. 途中参加者（late join）は RenderTexture が空の状態から始まる。公式の救済手段はない。再送設計で解く必要がある。

---

## 1. Expression Parameters の仕様

### 1.1 型とビットコスト
| 型 | 範囲 | 同期コスト | 出典 |
|---|---|---|---|
| int | 0–255 | 8 bit（符号なし8bit int） | [公式✔] AP |
| float | -1.0–1.0 | 8 bit（符号付き8bit固定小数点） | [公式✔] AP |
| bool | true/false | 1 bit | [公式✔] AP |

- AP = https://creators.vrchat.com/avatars/animator-parameters/ （Last updated 2025-12-12）
- 「VRChat can synchronize up to 256 bits of custom parameters. VRChat also limits your avatar to 8192 total custom Expression Parameters (synced and unsynced). Built-in parameters do not count toward these limits.」[公式✔]
- float の量子化: 「Remotely synced `float` values have 255 possible values, giving a precision of `1/127` over the network, and can store `-1.0`, `0.0`, and `1.0` precisely. When updated locally, such as with OSC, float values are stored as native (32-bit) floating-point values in animators.」[公式✔]
  - 送信者ローカルでは 32bit float、remote では 1/127 刻み → **送信者とremoteで値が異なりうる**。
  - 実際に「remote で 0.01 ずれる」バグ報告あり（2025-11, staff により tracked）https://feedback.vrchat.com/bug-reports/p/synced-float-parameters-on-avatars-dont-sync-correctly-off-by-001 [コミュ主張]
  - **→ データ伝送には int / bool を使い、float はビット詰めに使わないのが安全** [推測]。
- 同期パラメータは値がクランプされる（int [0,255], float [-1,1]）。Animator のみで定義したローカルパラメータはクランプされない [公式] https://creators.vrchat.com/avatars/state-behaviors/
- **パラメータは名前ではなく、リスト内の位置と型で対応付けられる** [公式] AP。PC/Quest 版で同じ Parameters アセットを使う必要がある。

### 1.2 予算の変遷
- 2021.1.1（2021-01）: 16パラメータ制限 → 128 bit に [公式] https://docs.vrchat.com/docs/vrchat-202111
- 2022.2.1（2022-05）: 128 → 256 bit に倍増。同時に「Avatar Parameters are now updated in Desktop Mode as quickly as they are in VR.」[公式] https://docs.vrchat.com/docs/vrchat-202221
  - → **2022-05 以前の資料（「5Hz」説など）はデスクトップの更新が遅かった時代のもの**の可能性 [推測]。
- 2024.2.1: 非同期パラメータは合計 8192 まで。同期分は 256 のまま [公式]
- 512bit 化の要望（Canny / osc issue #163）は 2026 年時点で未対応 [コミュ主張]

### 1.3 資料間の小さな食い違い（解決していない）
- 256 ちょうどは可か: リリースノート 2024.2.1「must still be below a cost of 256」vs SDK コードは `> MAX_PARAMETER_COST` で拒否（=256 は通る）。
- 8192 の対象: AP「synced and unsynced 合計」vs 2024.2.1 ノート「local/non-synced total」。
- float の符号化: 「signed 8-bit」（256コード）と「255 possible values」の差（残り1コードの扱い）は未文書。

---

## 2. 同期の仕組み

### 2.1 Sync Types（公式記述）[公式✔ AP]
| 種別 | 公式記述 | 対象 |
|---|---|---|
| Playable | 「Updates every 0.1 to 1 seconds as needed based on parameter changes (1 to 10 updates per second), but you shouldn't rely on it for fast sync.」 | カスタムパラメータの既定 |
| IK | 「Updates continuously every 0.1 seconds (10 updates per second), and interpolates `float` values locally for remote users.」 | Puppet（Radial等）操作中のカスタムパラメータ、GestureLeft 等 |
| Speech | 音声からローカル計算 | Viseme, Voice |
| None | 同期しない | IsLocal 等 |

- 「when you control a parameter with a Puppet control, VRChat switches from Playable to IK sync… When you close the Puppet control, it returns to Playable sync.」[公式✔]
- Expression Menu ページ: 「Button/Toggle uses Playable Sync which updates on-demand, instead of continuously」「Puppet menu sync always updates at the maximum rate available, and it smooths the values for remote users」、Button は「resets after the sync/reset has been sent-- usually after about a second」[公式] https://creators.vrchat.com/avatars/expression-menu-and-controls/

### 2.2 公式に書かれていないこと [未確認]
- Playable の送信が「変化時に即」なのか「固定tickで変化があれば」なのか、最小間隔、変化が続いた時に 10Hz を維持するか。
- 送信間隔より速い変化が**捨てられる（最後の値のみ）か、キューされるか**。
- 順序保証、reliable/unreliable の別。
- OSC で駆動した同期パラメータが Playable か IK か。OSC 入力のレート制限。
- 距離・可視性・人数による帯域の間引き（2020.1.1 のノートには「遠い/見えない人は帯域を使わない」とあるが [公式]、パラメータに適用されるか、現行値は不明）。
- 2026.2.1「Unreliable network data (e.g. VRC Object Sync…) will now be dropped client-side if the outgoing queue gets too large. The latest state will still always be transmitted」[公式] — アバターパラメータが該当するかは不明。
- Late joiner が現在値を即受け取るか。

### 2.3 コミュニティの実測・経験値
| 出典 | 内容 | 種別 |
|---|---|---|
| VRCBitmapLed README（2025） https://github.com/lolosiax/VRCBitmapLed | 送信間隔 100ms=損失大, 120ms≈1/5損失, 130ms≈1/7, 140ms=まれ, 200ms=損失なし。Pointer(Int)+Data(Int) を毎tick変更し全アドレスを周回 | [コミュ実測✔] 測定方法・観測側（remote/local）・人数・fps 記載なし |
| VRCFury Parameter Compressor（コード） https://github.com/VRCFury/VRCFury | `BATCH_TIME = 0.1` に**1フレーム追加**。コメント「We can't just go to the next send after 0.1s, because of a weird unity animator quirk where it will exit "early"… which would potentially make it update faster than the sync rate and lose a packet.」エミュレータ用フックに「the game actually uses 0.1s」 | [コミュ主張✔] 実運用で広く使われている |
| VRC Parameter Compressor（BOOTH, 2026-03） https://booth.pm/ja/items/8030052 | 「同期バッチの保持時間を 0.1s（3/30）に調整し、同期の取りこぼしを起きにくくしました」 | [コミュ主張] |
| KillFrenzy Avatar Text 系送信アプリ群 | 送信間隔 250ms が標準。「Setting this too low will cause issues」 | [コミュ主張] |
| MemoryOptimizer | 既定 stepDelay 0.2s | [コミュ主張] |
| vrc-worldobject（2022） | 「Avatar parameter sync is atomic」（Merlin の Discord スクショ）、「VRChat network sync happens 5 times per second」、OSC で複数パラメータを更新するのは原子的でない | [コミュ主張✔] 5Hz は 2022.2.1 以前 or 直後 |
| Lyuma Av3Emulator | remote 複製は 0.2s ごとに**現在値をコピー**（last-value-wins モデル） | [コミュ主張] エミュレータの仮定 |
| Statek（Canny 2022） | 「float parameters update over the network at around 10Hz with no smoothing」（OSC駆動時） | [コミュ主張、動画あり] |
| 風庭ゆい note（2022） | 同じパラメータを 0.2〜0.3秒未満で書き換えると反映されない（体感、ローカル） | [コミュ実測・非厳密] 他プロジェクトは10〜100ms でローカル駆動しており食い違う |
| みみー note（2025） | 送信タイミングで全同期パラメータを1データにシリアライズ、受信側は順番と型でデコード | [コミュ主張] |

**厳密な実測（パケットキャプチャ・remote 側での受信時刻ログ等）は見つからなかった。**

### 2.4 本プロジェクトで採用する作業仮説（要実験）[推測]
- **チャネルモデル**: 送信者の Animator 状態（256bit）を、周期 T≈0.1s＋ジッタで標本化し、全ビットを1スナップショットとして remote に配送。途中の値は失われる。
- **1シンボルの保持時間 H** を損失率とのトレードオフで選ぶ（候補 H = 0.1s+1f / 0.14s / 0.2s）。
- パケットは**自己記述的（アドレス/シーケンスを含む）かつ冪等**でなければならない（同じパケットを何度受けても、何フレーム適用しても結果が同じ）。
- 受信側では「前回と同じ値が続いた」のか「同じ値のパケットがもう一度来た」のか区別できない → **連続パケットは必ずどこかのビットが変わるように設計**（シーケンス番号など）。

### 2.5 素朴なスループット見積もり [推測]
ヘッダ（シーケンス/アドレス）を h bit とした payload レート:

| 利用可能 bit | h | H=0.1s（理想） | H=0.14s | H=0.2s |
|---|---|---|---|---|
| 256 | 16 | 2400 bps | 1714 bps | 1200 bps |
| 128 | 12 | 1160 bps | 829 bps | 580 bps |
| 64 | 10 | 540 bps | 386 bps | 270 bps |
| 32 | 8 | 240 bps | 171 bps | 120 bps |

参考: 256bit・H=0.2s で 20秒送ると 24 kbit = **3 KB**。64bit では 20秒で 675 B。
→ JPEG の低品質サムネイル（〜数KB）程度が 256bit で 10〜20秒、というオーダー。32bit では 20秒で 300 byte 程度しかなく、「コマンド描画・ベクタ化・極低解像度」の領域。

---

## 3. Built-in パラメータとクロック

- Built-in は予算を消費しない・読み取り専用 [公式✔]。
- IK 同期の built-in: GestureLeft/Right, AngularY, Velocity*, Upright, Grounded, Seated, AFK, VRMode, InStation, AvatarVersion 等。Playable: GestureWeight, TrackingType, MuteSelf, Earmuffs, Scale系 等。None: IsLocal, PreviewMode, IsAnimatorEnabled [公式]。
- **カウンタ／時刻として使える built-in パラメータは無い**。
- **シェーダーグローバル `_VRChatTimeNetworkMs`**: 「Synchronized network time in milliseconds. This is the same value as returned by `Networking.GetServerTimeInMilliseconds` in Udon… It should only be used for synchronization and offsets… This value can wrap.」アバターのシェーダーからも使える [公式✔] https://creators.vrchat.com/worlds/udon/vrc-graphics/vrchat-shader-globals/ （SDK 3.10.2, 2026-02 追加）
  - 送信側・受信側のシェーダーで共通の時計が得られる可能性がある。ただしパラメータの到着時刻自体は遅延/ジッタを持つので、「パラメータとネットワーク時刻の対応」はとれない [推測]。
  - shader の float で ms 整数を扱うと 2^24 を超えた所で精度が落ちる懸念 [推測・要確認]。

---

## 4. Parameter Driver / OSC / Contacts / PhysBones

- Parameter Driver は `Local Only` を付けないと remote でも実行される。Add/Random は remote で結果が一致しない可能性があるため、「同期パラメータを出力先にしてローカルでのみ実行」が推奨 [公式] https://creators.vrchat.com/avatars/state-behaviors/
- 極短時間のステートで State Behavior が実行される保証はない（Unity の仕様）[公式]
- float→int 変換: Driver の Copy は「常に切り捨て」、Animator の型不一致は「Mathf.Round」と記述が分かれる [公式・食い違い、別経路の可能性]
- OSC: `/avatar/parameters/<name>` で設定。同期パラメータを OSC で設定すると同期される（フェイストラッキング用途として公式ブログが紹介）[公式]。**OSC 入力の一括更新は原子的ではない**（1 OSC メッセージ＝1パラメータ、フレームをまたぎうる）[コミュ主張] → ロックビット等の対策が必要。
- Contacts / PhysBones のパラメータは各クライアントでローカル計算され、同期不要 [公式]。

### 4.1 エンコーダの配置
- **OSC アプリ（PC 上の外部プログラム）から駆動するのが最も柔軟**（重いエンコード・事前計算が可能、全 256bit を任意に制御）。KAT, VRCBitmapLed, VRCFaceTracking 等すべてこの形 [コミュ主張]。
- アバター単体（Animator 内にデータを焼き込む）でも可能だが、送る画像がアップロード時に固定される [推測]。

---

## 5. 描画側（Camera / RenderTexture / シェーダー）の前提

### 5.1 Camera コンポーネント [公式✔]
https://creators.vrchat.com/avatars/whitelisted-avatar-components/whitelisted-avatar-components/
> For avatars worn by the local user, Camera components are fully whitelisted. For remote users, the following rules apply:
> - In all cases, the Camera components of remote users are disabled when the avatar is loaded. You can use animations to enable Camera components.
> - If the local user and remote user are friends, Camera components are not removed. (Note that becoming friends with a user does not automatically reload their avatar.)
> - If the local user has selected "Show Avatar" for the remote user in VRChat's quick menu, Camera components are not removed.
> - If neither of the above is true, Camera components are removed and cannot be enabled.

- Quest/Android: 「Cameras — Completely disabled for avatars on Android and Quest.」「VRChat on Android or Quest only permits the shaders provided with the latest SDK on avatars.」[公式✔] https://creators.vrchat.com/platforms/android/quest-content-limitations/
- 性能: カメラ1台のコストは「massive」（Tupper, 2019）[公式スタッフ]。2カメラのフィードバックループで CPU 約0.7ms という報告 [コミュ主張]。性能ランクに Camera 項目は無い [公式]。
- アバター上の Graphics.Blit は未提供（Canny 要望のみ）[コミュ主張]。

### 5.2 シールド（セーフティ）
- 既定の Normal Shield では Shaders は Trusted 以上/フレンドのみ ON、Custom Animations は User 以上 ON [コミュ主張: wiki]。
- シェーダーが無効だと Standard に置換される。`"VRCFallback"="Hidden"` でメッシュを隠せる [公式] https://creators.vrchat.com/avatars/shader-fallback-system/
- → 実質的な視聴可能者: **PC かつ（フレンド or Show Avatar 済み）**。Show Avatar はシェーダー等もまとめて許可するので、非フレンドにも「Show Avatar を押してもらう」運用なら見せられる [推測]。

### 5.3 カメラループ（RenderTexture フィードバック）[コミュ主張✔ pema99]
https://github.com/pema99/shader-knowledge/blob/main/camera-loops.md
- 1枚の RT を読み書きする方式は壊れやすい。**2枚の RT／2カメラによるダブルバッファリングを常に使うべき**。整数フォーマットの1枚ループが動くのはカメラの HDR が暗黙に 16bit float に blit しているためで、HDR off で壊れる。
- 「Cloning an avatar using a camera loop causes jankiness because both instances of that avatar will be writing to the same RenderTexture due to them having the same avatar ID.」→ 別アップロードで回避。
- カメラの cullingMask を UiMenu レイヤーだけにする手法。
- フラグメントシェーダーは「今塗っているピクセル」にしか書けない → 矩形塗りは全画素判定で可、任意位置への点書き込みはジオメトリシェーダーで小quadを生成 [コミュ主張]。
- 実装例: traP のアバター内ゲーム（RGBA8 に bit packing、Point フィルタ）https://trap.jp/post/1743/ 、SCRN KungFu-Chat。
- 注意点 [推測]: Linear（非 sRGB）RT、Point フィルタ、mip なし、MSAA 無効、テクセル中心サンプリング/`Load()`。ARGBFloat RT で旧来クラッシュ報告あり（2018, 放置クローズ）。

### 5.4 冪等性とフレームレート [推測]
- カメラは各クライアントのフレームごとに描画し、1パケットは数〜十数フレーム持続し、フレーム数はクライアントで異なる。
- → **「加算」型コマンド（DCT係数の加算など）は、RT 内に「最後に適用したシーケンス番号」を保存して1回だけ適用**する必要がある。「上書き」型（ブロックをこの値にする）なら自然に冪等。

### 5.5 Animator → マテリアル
- KAT: 同期パラメータ → 1D ブレンドツリー（-1 と 1 の2クリップ）→ マテリアル float プロパティ、Write Defaults Off で実績あり [コミュ主張]。
- Int→プロパティも 0 と 255 の2クリップの 1D ブレンドツリーで厳密整数になるはず [推測・要 remote 検証]。
- remote のアニメーターは**画面外でカリングされ、カリング中は動かない**（Tupper 2025-07）[公式スタッフ]。距離で非表示のアバターの Animator は無効化（2025.1.1）[公式]。**→ 視聴者が後ろを向いた・離れた間のパケットは取りこぼす**前提で設計する必要。
- Hidden 時にアニメーターは動き続けるとする設定ページと、距離非表示で無効化するというリリースノートが食い違い [公式間の矛盾]。

### 5.6 解像度・メモリ
- Texture Memory 上限（PC）: Excellent 40 / Good 75 / Medium 110 / Poor 150 MB [公式]。RT がこの統計に算入されるかは不明 [未確認]。
- RGBA8 256² ×2 ≈ 0.5 MB、1024² ×2 ≈ 8 MB [推測]。帯域（数KB/20秒）に対してバッファは十分に大きい。

---

## 6. カメラを使わない代替: Animator のローカルパラメータをバッファにする [推測中心]

- VRCBitmapLed は受信した Pointer/Data を remote の Animator 内で **非同期パラメータ（256〜768個）にコピー**して表示している [コミュ主張]。Camera 不要のため**フレンド制限がない**（ただしシェーダー/アニメーションのシールドには従う。Quest ではカスタムシェーダー不可）。
- remote で冪等にデータをラッチする Animator ロジックは remote でも実行される（Driver を Local Only にしない）ので可能 [公式の仕様から推測]。
- 制約 [推測]:
  - バッファ容量＝ローカルパラメータ数（上限 8192 は Expression Parameters の話。Animator 内だけで定義したパラメータの上限は未確認）。1パラメータ=float32 に 8〜24bit 程度を詰めれば、数千パラメータ×数十bit で数十 KB 相当の状態を持てる可能性。
  - マテリアルへ値を渡すには各パラメータを animated property にする必要があり、数百〜数千プロパティのアニメーションは CPU 負荷・Animator 構築の手間が大きい。
  - Animator がカリング/無効化されると更新が止まる点はカメラ方式と同じ。アバターリロードで状態が消える点も同じ。
- **表示画質をどこまで出せるか（例: 64×64 パレット画像＝4096 画素）は、プロパティ数の制約次第で要検証。**フレンド制限回避の価値が大きいので、方式検討時に比較対象に含めるべき。

---

## 7. データ送信系の既存プロジェクト（要約）

| プロジェクト | データ | 方式 | bit | タイミング | 備考 |
|---|---|---|---|---|---|
| VRCFury Parameter Compressor | メニュー値 | 時分割（index + data slots） | 可変 | 0.1s+1f / batch, ack なし | 実用実績大 |
| KillFrenzy Avatar Text | テキスト | pointer(int)+文字(float, 1/127刻み) | 18–74 | 250ms, 差分送信＋空き時にポインタ再送 | float に文字コードを乗せている |
| VRCBitmapLed | 16×16 ドット文字 | pointer(int)+data(int)、remote でローカルパラメータへ保存 | 17–32 | 200ms 周回、損失表あり | カメラ不要 |
| VRC Avi Display（有料） | テキスト・**画像** | 「テクスチャへシリアライズ」 | 不明 | 不明 | 画像で「10秒〜2分以上」、PC のみ、フレンドに見える、同アバター複数で不具合 |
| VRChatImageSendSystem（2022） | 64px 32色、四分木矩形 | 色+位置 int + Plot パルス | 約100 | 50ms パルス | **「多くの人が見えない」で放棄**。パルスが同期周期より短い＋カメラのフレンド制限が原因と推測 |
| video-over-OSC | 14×8 1bit | 16 float にストリップを直接格納（ステートレス） | 約136 | 不明 | バッファ不要 |
| vrc-worldobject | 位置 | selector + 値 + ロックビット、連続周回 | 約16/軸 | 「5Hz」前提 | 原子性の議論 |
| VRCFaceTracking binary | 表情 float | N bool の 2進数 + 符号 bit | N+1 | 多重化なし | 精度と bit のトレードオフの前例 |
| VRChat-OSC-Video（vFeez, 2025-06〜10, Python） https://github.com/vFeez/VRChat-OSC-Video | Webカメラ映像 16×14 | R/G/B 各 2bit を 1 byte=4 画素で int に詰める。1 パケット = 1 色チャネル × インタレース 1 フィールド（7 行×4 byte=28 int）。ヘッダは bool 3 個（RG, B でチャネル選択、interlacing_flag でフィールド）＋ Ratio float | 224+3+8 ≈ 235 | `time.sleep(0.11)` ごとに送信（OSC 31 メッセージを逐次送信→非原子的）。連番・再送・ack なし。カラー 1 フレーム=6 パケット（README「~1.5FPS」）、モノクロ 2 パケット（「~5fps」） | 映像なので欠落・半端パケットは次フレームで上書きされる前提。リモートでの実測値の記載なし。受信側アバター（公開 avtr_c8a3370f-…）の実装はリポジトリに無く未確認 |
| AvatarImageReader（ワールド側） | バイト列 | アバターのサムネ画像の画素 | — | 静的 | 参考（パラメータではない） |

URL は §2.3 と以下: https://github.com/killfrenzy96/KillFrenzyAvatarText , https://elede.gumroad.com/l/VRCAviDisplay , https://github.com/kaitaryu/VRChatImageSendSystem , https://github.com/wasokeli/video-over-OSC , https://github.com/seanedwards/vrc-worldobject , https://github.com/Miner28/AvatarImageReader

**教訓** [推測]:
- 同期周期より短いパルス（Plot bool 50ms 等）は remote で確実に落ちる。
- 成功例はすべて「状態（値）を一定時間保持」＋「アドレス付き」＋「周回再送」。
- 画像送信の先行品（VRC Avi Display）でも 10秒〜2分オーダー。

---

## 8. 矛盾・曖昧点の一覧（未解決のまま記録）

| # | 論点 | 記述A | 記述B |
|---|---|---|---|
| C1 | 同期周期 | 公式 IK「0.1s ごと」, VRCFury「the game actually uses 0.1s」 | vrc-worldobject「5 times per second」(2022), Av3Emulator 既定 0.2s |
| C2 | Playable の頻度 | 公式「0.1〜1秒 as needed」 | 実運用は 0.1s+1f〜0.25s で「連続変化でも追従」を前提にしている。Button は「usually after about a second」 |
| C3 | 損失なしの保持時間 | VRCFury 0.1s+1f で運用 | VRCBitmapLed 100ms で損失大、140ms でまれ、200ms で無し |
| C4 | ローカルの OSC 反映 | 風庭ゆい: 0.2〜0.3s 未満は反映されない | 他プロジェクトは 10〜100ms でローカル駆動 |
| C5 | 非表示アバターの Animator | 設定ページ: animators は動き続ける | 2025.1.1: 距離非表示で無効化 / スタッフ: 画面外カリング中は動かない |
| C6 | Remote float の補間 | 公式: IK sync のみ補間 | VRCFT 系資料: float は「smoothed over the network」、Statek: 「no smoothing」 |
| C7 | カメラの可視範囲 | pema99/traP: フレンドのみ | 公式（2023.4.2 以降）: フレンド or Show Avatar |
| C8 | RT 共有問題 | 2019 Canny / pema99: 同アバターで RT 共有 | 最近の確認・修正情報なし |
| C9 | float 量子化 | 「signed 8-bit」 | 「255 possible values」、remote で 0.01 ずれるバグ報告 |
| C10 | 256 ちょうど | ノート「below 256」 | SDK は 256 を許可 |

---

## 9. 実験で確定すべき事項（優先度順）

**P0（方式設計の根幹）**
1. **remote 観測での損失率 vs 保持時間 H**（H = 67/100/117/133/150/200ms, 送信側 fps 45/60/90, 観測者 1〜数人, VR/Desktop）。全 256bit を毎パケット変化させた場合と一部だけ変化させた場合。
2. **スナップショットの原子性**: 同一フレームで Animator が変更した複数パラメータが、remote で「一部だけ新しい」状態になることがあるか。OSC で複数フレームにまたがって書いた場合。
3. **カメラループの remote 動作**: フレンド／非フレンド+Show Avatar で動くか、ダブルバッファ RGBA8 でバイトが厳密に往復するか、同一アバター2人着用時の RT 共有。
4. **Int → マテリアル float の厳密性**（remote で 0..255 が正確に届くか）。

**P1（ロバスト性）**
5. 視聴者が後ろを向いた・距離で非表示にした間の挙動（更新停止→再開時に最新値だけ反映されるか、`IsAnimatorEnabled` の挙動）。
6. Late join 時の初期値の到着時間。
7. Playable が連続変化で 10Hz を維持するか、Puppet(IK) 中は bool/int のレートも変わるか、OSC 駆動時の sync type。
8. 人数（10〜40人）での遅延・損失の変化。

**P2**
9. `_VRChatTimeNetworkMs` のクライアント間一致度・シェーダーでの精度。
10. Animator ローカルパラメータバッファ方式の規模限界（パラメータ数・アニメーションプロパティ数と CPU 負荷）。
11. RT が Texture Memory 統計に入るか、性能ランクへの影響。

**測定方法の案** [推測]: 送信側 OSC アプリが「連番 k（例: 8bit）＋ k から決まる擬似乱数ペイロード」を H ごとに送る。受信側アバターのシェーダーは受信値が期待値と一致するかを判定し、カメラループ RT に「受信済みビットマップ」と誤り数を描画 → 観測者側のスクリーンショット/録画で損失率・誤りを数える（remote 側の値を OSC で取り出す手段は無いため）。カメラが使えない条件ではローカルパラメータのカウンタを表示する。

---

## 10. 方式検討への含意（次フェーズの論点）[推測]

- 伝送路は「**約 0.1〜0.2秒ごとに 256bit（または割当分）の上書き型シンボル**、損失あり、ack なし、受信側は途中から見始め/途中で見なくなる」。
- 最終画質だけでなく途中画質・late join・損失回復を考えると、**「どのパケットを取りこぼしても、後で来るパケットで埋まり、受信順序に依存しない」**構造が望ましい。候補:
  - 階層型（低周波/低解像度優先）＋重み付き周回再送（重要度の高い係数ほど頻繁に再送）
  - 冪等なブロック上書き（「係数iを値vにする」）で加算型を避ける、またはシーケンス番号で一回適用
  - Rateless/fountain 符号（任意の K 個で復元）は late join に強いが、シェーダーでの復号と途中画質の両立が課題
  - コマンド型（矩形・パレット）は低 bit 予算（32/64bit）で有利な可能性
- 評価指標の候補: PSNR / SSIM / MS-SSIM / 知覚系（LPIPS 等はシェーダー実装と無関係なので評価専用）、「送信開始から t 秒後」の品質曲線、late join で t 秒後の品質曲線、損失率 p での劣化、必要 RT サイズ・シェーダーコスト。
- **カメラ（フレンド/Show Avatar 限定, PC のみ）を受け入れるか、ローカルパラメータバッファ方式でより広い視聴者を狙うか**は方式選択の上位の分岐。
