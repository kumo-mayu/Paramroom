# 使っているもの・素材の出典

このリポジトリ自体は MIT ライセンス（`LICENSE`）です。以下は、同梱・依存しているものと、その条件です。

## 送信アプリ・CLI（`tools/`、配布物に含まれる）

| もの | 用途 | ライセンス |
|---|---|---|
| [StbImageSharp](https://github.com/StbSharp/StbImageSharp) | 画像（PNG/JPEG など）の読み込み | Unlicense OR MIT |
| [VRChat.OSCQuery](https://github.com/vrchat-community/vrc-oscquery-lib) | VRChat を見つけ、アバターのパラメータを読む | MIT（VRChat Inc.） |
| [Net.Codecrete.QrCodeGenerator](https://github.com/manuelbl/QrCodeGenerator) | QR コードの生成 | MIT |

PNG の書き出しは `tools/ImagePad.Core/PngWriter.cs` の自前実装です（以前使っていた
StbImageWriteSharp はライセンス表記が無く、再配布できないため外しました）。

## テスト（配布物には含まれない）

xunit（Apache-2.0）、xunit.runner.visualstudio（Apache-2.0）、coverlet.collector（MIT）、
Microsoft.NET.Test.Sdk（MIT）。

## シミュレータ（`sim/`、研究用。配布物には含まれない）

| もの | 用途 | ライセンス |
|---|---|---|
| [pngjs](https://github.com/pngjs/pngjs) | PNG の読み書き | MIT |
| [jpeg-js](https://github.com/jpeg-js/jpeg-js) | JPEG の読み込み | BSD-3-Clause |
| [qrcode](https://github.com/soldair/node-qrcode) | QR コードの生成（調査用） | MIT |
| [jsQR](https://github.com/cozmo/jsQR) | QR コードの読み取り（調査で「読めるか」を判定するため） | Apache-2.0 |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | 比較画像の組み立て（`measure/analysis/`） | ffmpeg 本体は LGPL/GPL。画像を並べるためだけに使用 |

## テスト画像（`sim/images/`、研究用）

出典と条件は `sim/images/SOURCES.txt` にまとめてあります。主なもの:

- **Kodak Lossless True Color Image Suite**（`kodim*`）— 研究用途での自由な利用が認められているもの
- **Wikimedia Commons** の画像 — CC0 / CC BY 3.0 / CC BY 4.0 / CC BY-SA 3.0 / パブリックドメイン。
  ファイルごとの作者・ライセンスは `SOURCES.txt` を参照
- **CC BY-SA の画像を含みます**（Wikipe-tan, Girl in chibi style など）。
  `measure/results/` の比較画像はこれらから作った派生物なので、再配布する場合は
  `SOURCES.txt` の帰属表示を一緒に持っていってください

## 参考にしたもの（コードは使っていない）

- 送信アプリの構成（コマンドとスナップショットでやり取りする作り）は、同じ作者の
  booth-asset-manager を参考にしています
- アバターの切り替えを OSCQuery で知る方法は、同じ作者の vrc-osc-recorder を参考にしています
