Paramroom v0.2.2
================

VRChat のアバターに、PC の画像や QR コードを送って周りの人に見せるギミックです。
アバターの同期パラメータだけを使います。

  GitHub : https://github.com/kumo-mayu/Paramroom
  BOOTH  : https://kumo-mayu.booth.pm/items/8868240
  お問い合わせ : BOOTH ショップのメッセージ、または X（@kumo_mayu79）の DM


■ この版について

  アバターの作り直しは不要です（v0.2.0 以降で作ったアバターはそのまま使えます）。
  送信アプリ（Paramroom.App.exe）を置き換えるだけで済みます。
  v0.1.0 から上げる場合は、プレハブを作り直してください。

  - Paramroom の入っていないアバターを着ていると、送信アプリが 10 秒ごとに VRChat へ
    接続し直していた不具合を直しました。接続は起動中 1 回だけになります
  - アバターを着替えると、数秒で送信先が切り替わるようになりました
  - 説明文の直し（画像は 80 秒ほどで「ほぼ」揃い、全部揃うまでは 90 秒ほど）


■ 入っているもの

  Paramroom-unity-v0.2.2.unitypackage … アバターへの導入ツール（Unity にインポートする）
  Paramroom.App.exe                     … 画像を送る Windows アプリ（インストール不要）
  LICENSE                               … Paramroom のライセンス（MIT）
  THIRD-PARTY-NOTICES.txt               … アプリが使っているライブラリのライセンス
  README.txt                            … このファイル


■ 必要なもの

  - Unity 2022.3.22f1 ＋ VRChat SDK (Avatars) 3.10.4 ＋ Modular Avatar 1.17.1（この組み合わせで確認）
  - アバターの同期パラメータの空き（画像も出すなら Int 9 個 = 72bit から、QR コードだけなら Int 3 個 = 24bit から）
  - Windows の PC と、VRChat の OSC が有効なこと
  - PC 版の VRChat 専用です（Android 版・iOS 版では動きません）


■ アバターに入れる

  1. Paramroom-unity-v0.2.2.unitypackage をプロジェクトにインポートする
     （Assets/kumo-mayu/Paramroom に入ります）
  2. ヒエラルキーで導入したいアバターを選ぶ
  3. Tools > Paramroom > Decoder Builder を開き、収まる Int の数を選んで「プレハブを作成」
     （迷ったら最初に選ばれている 形式 4 ＋ Int 32 個）
  4. 生成された Assets/kumo-mayu/Paramroom/ParamroomDecoder*.prefab をアバターの直下に置く
  5. 表示板（Display）を見せたい位置・大きさに動かす
  6. アバターをアップロードする

  同期パラメータがほとんど空いていない場合は、ビルダーの「QR 専用」タブから作ってください。
  Assets/kumo-mayu/ の名前を変えたり動かしたりしないでください。


■ 画像を送る

  1. VRChat の OSC を有効にする（Action Menu > Options > OSC > Enabled）
  2. 上の手順でギミックを導入したアバターに着替える
  3. Paramroom.App.exe を起動する（アバターは自動で見つかります）
  4. 画像を指定する（ファイル／URL／ドラッグ／Ctrl+V のどれにも対応しています）
     QR コードにしたい文字列は、QR の欄に入れて「QR コードにする」
  5. 「送信を始める」

  初回起動時に「Windows によって PC が保護されました」と出たら、
  「詳細情報」→「実行」で起動できます（exe に電子署名をしていないためです）。


■ 注意

  - 相手に見えるのは、フレンドか「Show Avatar」をしてくれた人だけです
  - 同じアバター（同じ blueprint ID）を 2 人以上が着ていると絵が壊れます
  - 相手の画面でこちらのアバターが見えていない間（カリングなど）は描画が進みません
  - 人が多い場所や相手のフレームレートが低いときは、アプリで送信の間隔を伸ばしてください

  詳しい説明は GitHub の README にあります。


■ ライセンス

  MIT ライセンスです（LICENSE）。改変・再配布できます。著作権表示と LICENSE を残してください。
  送信する画像の権利と、VRChat の規約は守って使ってください。

  QRコードは株式会社デンソーウェーブの登録商標です。
