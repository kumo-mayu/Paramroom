# 調査報告 03: リモート側の動作を確認する方法（複数クライアント起動の利用可否）

調査日: 2026-09-17
凡例: [公式] VRChat 公式資料・スタッフ発言 / [コミュ] 非公式 / [推測] / [未確認]。✔ = メイン agent が原文で文言を確認済み。

## 0. 結論

1. **複数クライアント機能（Number of Clients）はワールド SDK の Build & Test の機能**。同一アカウントで最大 8 クライアント（2025.3.3 以降は台数制限なし）をローカルテストワールドに起動し、各クライアントは「別プレイヤー」として扱われる [公式✔]。アバター SDK 側の Build & Test にはクライアント数設定は無い（アバターはローカルテスト用アバターとして自分だけに表示）[公式✔/推測]。
2. **リモート視点の確認に部分的に使える**。ただし以下の制約がある。
   - **ローカルテストアバターは自分にしか見えない** → 送信用アバターは**非公開（Private）アップロードが必要** [公式✔]。
   - **同一アカウントの複数クライアントはローカルテストワールドでのみ同じインスタンスに入れる**。アップロード済みワールドでは同一アカウントの重複は弾かれる（スタッフ「intended behaviour」）[公式]。
   - **カメラの可視条件（フレンド / Show Avatar）を同一アカウント同士で満たすかは文書化されていない** [未確認]。満たさない場合、受信側でアバターの Camera が除去され、**カメラループ方式は同一アカウントでは検証できない**。
3. **推奨構成: 別アカウント 2 つ（フレンド同士）**。同一 PC の `--profile=1` または 2 台の PC。フレンド／非フレンド＋Show Avatar／非フレンドの 3 条件を検証できる。ToS は BAN 後の新規アカウント作成を禁じているのみで、テスト用の複数アカウントを禁じる記述は見当たらない [公式、解釈は推測]。
4. リモート側のパラメータ値を OSC やデバッグ表示で直接読む手段は文書化されていない → **受信側の画面にシェーダーで計測値を描き、録画して解析する**のが主な測定手段になる [推測]。

## 1. 複数クライアント機能

- 「you can use the 'Number of Clients' field to launch up to 8 local clients that will launch in a private test world. They will all have the same DisplayName, but they'll otherwise be recognized as separate players」[公式✔] https://creators.vrchat.com/worlds/udon/graph/
- 「You can now run an unlimited amount of simultaneous VRChat clients on one machine.」（2025.3.3）[公式✔] https://docs.vrchat.com/docs/vrchat-202533
- 起動オプション [公式✔] https://docs.vrchat.com/docs/launch-options : `--profile=X`（別ユーザープロファイル）、`--no-vr`、`--fps=X`、`--enable-debug-gui`、`--watch-worlds`、`--watch-avatars`、`--osc=inPort:outIP:outPort`
- 2024.3.2「Avatar interaction now works when using multiple clients with the same account, such as with Build & Test.」[公式] https://docs.vrchat.com/docs/vrchat-202432
- アップロード済みワールドでの同一アカウント重複は不可（2019 Aev、2025 _tau_「This is and always has been intended behaviour」）[公式スタッフ] https://feedback.vrchat.com/bug-reports/p/able-to-be-in-two-different-vrc-instances-at-the-same-time-pc
- ローカルキャッシュの SDK 3.10.4 を確認したところ、クライアント数の設定はワールド側 DLL にのみ存在し、アバター SDK エディタには無い [推測: バイナリ文字列の確認]。

## 2. アバターの扱い

- 「Test avatars can only be seen by you. In order for other players to see your avatar, you need to upload it.」[公式✔] https://creators.vrchat.com/avatars/creating-your-first-avatar/
- 「Locally built avatars are _only_ visible to you! To everyone else, you'll look like you're wearing the last avatar…」[公式✔] https://creators.vrchat.com/avatars/
- 同一 PC・同一アカウントの別クライアントがローカルテストアバターを見られるか [未確認]（数分で確認できるが、見えない前提で Private アップロードを使う）。
- 受信クライアントは別プレイヤーなので、送信者アバターを `IsLocal=false` のリモートとして動かし、パラメータはネットワーク経由で届くはず [推測]。
- 同一アカウント同士で `IsOnFriendsList` がどうなるか [未確認] → シェーダーで表示して確認。

## 3. OSC

- 既定は受信 9000 / 送信 9001、`--osc` で変更可 [公式] https://docs.vrchat.com/docs/osc-overview
- 送信側と受信側でポートを分ける（例: 送信 `--osc=9000:127.0.0.1:9001`、受信 `--osc=9010:127.0.0.1:9011`）。OSCQuery の自動検出は 2 つのクライアントを広告してしまうので使わない。受信側は OSC を無効化 [推測]。設定は同一 PC のプロファイル間で共有されるという情報あり [コミュ]。
- OSC 出力は自分のアバターのパラメータのみ。**リモートアバターのパラメータ値を OSC で取得する手段は文書化されていない** [公式の記述範囲から推測]。

## 4. カメラの可視条件

- 「If the local user and remote user are friends, Camera components are not removed… If the local user has selected "Show Avatar"… If neither of the above is true, Camera components are removed and cannot be enabled.」[公式✔]（01 報告書 §5.1）
- 同一アカウント同士がフレンド扱いか、自分自身に Show Avatar を設定できるか [未確認]。

## 5. その他の確認手段

| 手段 | できること | できないこと |
|---|---|---|
| 別アカウント 2 つ（同一 PC `--profile` / 2 台） | 実ネットワーク経由のリモート受信、フレンド／Show Avatar の 3 条件、アップロード済みワールドでの途中参加 | 遠距離回線、Quest |
| 協力者（フレンド） | 実際の遠隔回線、別 GPU、VR 受信 | 手軽さ、細かい条件制御 |
| Av3Emulator（Lyuma）の Non Local Clone | ロジック・量子化の確認（remote 複製は `NonLocalSyncInterval = 0.2` 秒ごとに全同期パラメータを同一フレームでコピー、float は ×127 丸め）[コミュ: ソース確認] | タイミング・欠落・ジッタ・原子性・途中参加・カメラ規則（固定間隔・無損失・一括の理想化） |
| ClientSim | — | ワールド専用、アバター同期なし |
| clumsy / NetLimiter 等で遅延・欠落注入 | 劣悪回線の擬似 | EAC との相性 [未確認]、実回線とは異なる |
| デバッグ表示（`--enable-debug-gui`、Debug View 4 Players の Intrvl / Fnl D 等）[公式] | 送信間隔・遅延目標の目安 | リモートアバターのパラメータ値の表示は無い |
| output_log | 参加・退出・アバター切替の時刻 | パラメータ値 |
| **受信画面の録画＋テストパターン解析** | 下記の測定すべて | — |

## 6. 注意点

- 追加クライアントが黒画面で固まる不具合: Settings > Debug > Logging が off だと発生、Errors Only/Full で回避（2025-12 報告、2026-09 時点でも報告あり）[コミュ] https://feedback.vrchat.com/sdk-bug-reports/p/cant-build-test-multiple-clients-any-more
- EAC の「Only one instance」エラー: SDK 設定で VRChat.exe のパスを手動指定、起動をずらす [コミュ]
- 別アカウントのプロファイルで Build & Reload するとインスタンスが分かれる不具合（2025-07 tracked）→ 招待/インスタンスリンクで合流 [公式]
- 同一 PC で 2 クライアント＋カメラループは GPU/CPU を共有する。受信側のフレームレートを記録し、描画落ちとネットワーク欠落を混同しない [推測]
- VR 受信は別 PC で最終確認 [推測]

## 7. 推奨測定手順（案）[推測]

### 準備
1. 測定用アバターを **Private アップロード**。受信側シェーダーが大きなブロックで次を描画:
   受信シーケンス番号 / パケット全体のチェックサム一致フラグ / `IsLocal`・`IsOnFriendsList` / カメラ生存カウンタ（RT に書かれ続ける値、カメラ除去で停止）/ 受信側フレームカウンタ
2. 送信 OSC アプリ: シーケンス番号＋チェックサム付きパケットを、保持時間 H（50/100/117/133/150/200/300/500 ms）ごとに送り、送信時刻を CSV 記録
3. アカウント A（送信・アバター所有者）と B（受信）をフレンドにし、非フレンドの C も用意
4. Debug Logging を Errors Only、SDK に VRChat.exe パス指定、起動をずらす
5. 起動例
   - 送信: `VRChat.exe --profile=0 --no-vr --fps=60 --osc=9000:127.0.0.1:9001 --enable-debug-gui -screen-width 960 -screen-height 540`
   - 受信: `VRChat.exe --profile=1 --no-vr --fps=60 --osc=9010:127.0.0.1:9011 --enable-debug-gui -screen-width 960 -screen-height 540`（受信側は OSC 無効）
   - 自作の簡素なワールドの Private/Invite インスタンスで合流
6. 受信ウィンドウを OBS 60fps（可能なら別 PC 120fps）で録画し、オフラインで復号して送信 CSV とシーケンス番号で突き合わせ

### 測定項目（sim の仮説値を置き換える）
| 項目 | 方法 | 置き換える sim の仮説 |
|---|---|---|
| スナップショット間隔の分布 | 毎フレーム値を変え、受信側で観測される番号の間隔をヒストグラム化。Puppet（IK 同期）有無で比較 | `nominal10` / `bmfit` の間隔分布 |
| 保持時間と欠落率 | H ごとに、送信したが一度も観測されない番号の割合 | 損失曲線 |
| 半端パケット率 | チェックサム不一致フレームの割合（全パラメータ同時変更 / ずらして変更） | torn 率 5% |
| 途中参加 | 受信側が再入室 → 最初の正しいパケットまでの時間、保持値が即座に見えるか | 参加時の扱い |
| カリング | 後ろを向く・距離・表示人数制限・非表示 → カウンタ停止と再開、RT 更新の有無 | cull バースト（ON 30 秒 / OFF 4 秒） |
| カメラループの可視性 | フレンド / 非フレンド / 非フレンド＋Show Avatar（フレンド化後は再読込が必要）、同一アカウント | 視聴可能者の範囲 |
| 遅延 | 送信時刻と受信観測時刻の差 | 150ms 固定 |

同一アカウント 2 クライアントでのクイック確認（Private アップロード済みアバター、ローカルテストワールド）は、§2・§4 の未確認事項（テストアバターの可視性、`IsOnFriendsList`、カメラの扱い）を数分で解消できるため、最初に行う価値がある。

### この構成で確認できないこと
- Quest/Android・iOS の受信（端末が必要）
- 遠距離の実回線（同一 PC・同一回線では不可、協力者が必要）
- 同一 PC 上での VR 受信のフレームタイミング
- サーバー側の内部仕様（再送規則・パケットのまとめ方）— 観測できるのは結果のみで、ビルド更新で変わりうる
- 多人数インスタンスでの帯域圧迫
