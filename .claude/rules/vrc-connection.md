---
paths:
  - "tools/Paramroom.Core/VrcConnection.cs"
  - "tools/Paramroom.Core/VrcDiscovery.cs"
  - "tools/Paramroom.Core/Session/**"
  - "tools/Paramroom.App/**"
  - "tools/Paramroom.Core.Tests/ConnectionTests.cs"
  - "measure/osc/**"
---

# VRChat との接続（接続・送信アプリ・OSC の道具を触るときに読み込まれる）

決め事の本体（`VrcConnection` は起動中 1 つだけ作り、使い回す）は CLAUDE.md の「作りの決め事」。

- アバターの変更は、知っている VRChat に HTTP でアバターを読み直すだけにする。
  VRChat を探し直す（mDNS）のは、どの VRChat も応答しないとき（未起動・終了・再起動）だけ
- `/avatar/change` を受け付けると名乗っておき、VRChat が送ってくる通知ですぐ読み直す
  （作者の vrc-osc-recorder と同じやり方）。取りこぼしても 10 秒ごとの読み直しで拾う
- ライブラリは「見つけた」しか知らせないので、終了した VRChat の古い登録が残る。
  応答しないものは一覧から外す
- **名乗る名前はプロセスごとに一意にする**（`Paramroom-Sender-<pid>`）。同じ名前が 2 つあると mDNS の登録が
  互いに上書きし合い、どちらのポートが使われるかが運任せになる（`docs/research/14`）
- **CLI は名乗らない**（`new VrcConnection(advertise: false)`）。探すだけなら名乗りは要らない
- 名乗りを確かめるときは `node measure/osc/mdns-watch.js --filter Paramroom`（受信だけ）。
  **古いビルドで測らない**（`bin/Release` に前の版が残る。09-18 のビルドで「13 秒ごとに名乗り直す」を再現してしまった）
- `ConnectionTests` がこれを見ている（偽の OSCQuery サーバーで、探し直した回数を数える）。実機の確認記録は `docs/dev/notes.md`
