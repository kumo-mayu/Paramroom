---
paths:
  - "README.md"
  - "docs/booth/**"
  - "measure/unity/Assets/kumo-mayu/Paramroom/README.md"
  - "measure/unity/Assets/kumo-mayu/Paramroom/Editor/ParamroomBuilder.cs"
  - "tools/Paramroom.App/**"
---

# おすすめの構成と秒数の書き方（README・BOOTH・ビルダーの既定・画面の文言を触るときに読み込まれる）

決め事の本体は CLAUDE.md の「作りの決め事」。

- 利用者に勧める基本の構成は「形式 4（軽量）＋ 32 Int」。README・ビルダーの既定・BOOTH のページはすべてこれを前提にする
- 画像の秒数は「80 秒ほどでほぼ揃う（全部揃うまでは 90 秒ほど）」（形式 4 ＋ 32 Int、100 ms/パケット）と書き、条件を添える
- 「1 周 80 秒で全部揃う」とは書かない。1 周（ユニット数 ÷ 10）で届くのは 9 割弱で、既定の送り方 fast+sqrt/8 は
  8 スロットに 1 回を再送に回すので、全部揃うのは取りこぼしなしでも 1 周の 8/7 倍（形式 4 で 92 秒）。
  80 秒の絵は完成との MS-SSIM 0.997〜0.998 で見た目はほぼ完成（`sim/complete-time.js`・`sim/progress-frames.js`）
- 形式 4 は形式 3 と同じ図形 4000 個を 1 パケット 5 個で送るので、1 周 80 秒（形式 3 は 100 秒）。序盤の絵もわずかに良く、
  最終画質はわずかに下（`measure/results/2026-09-17/precision`、シミュレーション）
- Int の下限は、画像も出すなら 9 個（72 bit）、QR 専用（形式 10）なら 3 個（24 bit）
- 形式 4 ＋ 32 Int が VRChat で正しく動くことは、2026-09-18 にユーザーが実機で確かめた
- 形式 3 は「最終画質を少しでも上げたい人向け」として残す。形式番号と中身は変えない（配ったアバターが壊れる）
