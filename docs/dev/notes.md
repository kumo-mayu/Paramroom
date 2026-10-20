# 開発メモ（覚えておくと早いこと・つまずき・読み方）

`CLAUDE.md` から移した参照用のメモ。決め事は `CLAUDE.md` にある。

## 覚えておくと早いこと（すべて実測）

- 保持 **100 ms** で取りこぼしほぼ 0、80 ms で 1 割落ちる。受信側の更新は 83〜100 ms ごと
- **アバターのパラメータは 1 フレームに 1 回更新される**（10 fps 制限で 100 ms、60 fps で 17 ms 間隔）。
  公式ドキュメントに記載は無い。OSC の**入力**はフレームに縛られず 1 つも落とさない
- **受信側が 30 fps 未満だと届きにくい**（半端パケットの判定に 2 フレーム要るため）。
  100 ms のとき 30 fps で全部届き、20 fps で少し取りこぼし、10 fps でほぼ止まる
- OSC バンドルでも **0.3%** は半端パケットになる
- 同じ blueprint ID のアバターを 2 人以上が着ると RenderTexture を共有して壊れる
- アバター上のカメラがリモートで動くのは**フレンドか Show Avatar を押した人だけ**。Quest では動かない
- 画像は 1 周 80 秒（形式 4 ＋ 32 Int。形式 3・5 は 100 秒）。全部揃うのは 1 周の 8/7 倍（形式 4 で 92 秒）。QR は Int の数しだいで 0.3〜3 秒、QR 専用なら Int 3 個から

### VRChat との接続（`CLAUDE.md`「VRChat との接続は 1 回だけ」）の実機確認

- 実機で確認済み（2026-09-19、ユーザー）：名乗り直しが止まる／Paramroom 入りに着替えると**数秒**で送信先になる
  （10 秒の見回りより速いので /avatar/change が届いていると見られる）／送信中の着替えで止まる／VRChat 再起動で見つけ直す

## つまずきやすいところ

- **`bash` のヒアドキュメントはバックスラッシュを壊すことがある。**
  `\\` を含むスクリプトは Write ツールでファイルに書いてから実行する
- C# の出力と node の出力を `diff` すると、**CRLF と LF** で全行が差分になる。`tr -d '\r'` を通す
- C# と JS で同じ文字列から QR を作っても、**ライブラリがマスクを別に選ぶ**ので一致しない。
  詰め方を比べるときは**同じマス目を両方に食わせる**
- 送信アプリを起動したままだとビルドが失敗する（`CLAUDE.md`「絶対に破らないこと 2」）

## 読み方（文脈を節約する）

大きいファイルは `Grep` で場所を絞り、`Read` の `offset`/`limit` で近くだけ読む。

| ファイル | 大きさ | 読み方 |
|---|---|---|
| `docs/research/08-primitive-representation-experiments.md` | 46KB | 見出しを Grep して節だけ。符号化方式の実験の全記録 |
| `sim/codecs/primx.js` | 46KB | 研究用の変種置き場。本番は `prim.js` |
| `docs/research/07`・`01`、`docs/design/02` | 29〜37KB | 根拠を辿るときだけ |
| `measure/unity/.../Editor/ParamroomBuilder.cs` | 34KB | 関数名で Grep（`Build`・`BuildQr`・`GoodLayouts`・`QrLayoutFor`） |
| `tools/Paramroom.Core/Session/ParamroomSession.cs` | 30KB | `StartEncode`・`RenderReceived`・`SendLoop` などで Grep |
| `tools/Paramroom.Core/PrimEncoder.cs` | 28KB | 符号化の本体。触る前に `docs/research/08` を読む |
| `tools/Paramroom.App/ViewModels/MainViewModel.cs` | 27KB | 表示文言はここ。`HoldOptions`・`QrNoteFor` などで Grep |
| `.../Shaders/ParamroomDecoder.shader` | 23KB | 冒頭のコメントに状態アトラスの地図がある。そこだけ読めば構造が分かる |
