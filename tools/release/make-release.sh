#!/bin/bash
# リリースの配布物を作る: exe・unitypackage・LICENSE・THIRD-PARTY-NOTICES.txt・README.txt と、BOOTH 用の zip。
#
#   bash tools/release/make-release.sh v0.2.1 v0.2.0 D:/work/ClaudeCode/Paramroom-release
#
# unitypackage は「前の版の unitypackage」を土台にする。リポジトリに .meta が無いので、GUID は
# 前の版からしか引き継げない。GUID が変わると、インポートしたときに上書きされず別物として入り、
# 生成済みのプレハブもシェーダーを見失う。新しいファイルを足したときは、この方法では入らないので
# Unity で書き出す（そのときも既存のファイルの GUID は前の版のものを使う）。
#
# zip の README は docs/booth/zip-README.txt。版ごとに先に直しておく。
set -euo pipefail
V=$1; PREV=$2; BASE=${3:-D:/work/ClaudeCode/Paramroom-release}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$BASE/$V"; WORK=$(mktemp -d)
mkdir -p "$OUT"

# exe: 単一ファイル・.NET 同梱。後ろの 2 つが無いと WPF のネイティブ DLL が外に出て、大きさも 2 倍になる
dotnet publish "$ROOT/tools/Paramroom.App" -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true \
  -o "$WORK/publish" -v q --nologo
cp "$WORK/publish/Paramroom.App.exe" "$OUT/"

# unitypackage: 前の版を展開し、各 asset だけを今のリポジトリのものに差し替える
gh release download "$PREV" --repo kumo-mayu/Paramroom --pattern '*.unitypackage' --dir "$WORK"
# --force-local: "C:/..." をリモートのホスト名と解釈させない
mkdir "$WORK/pkg"; tar --force-local -xzf "$WORK"/Paramroom-unity-"$PREV".unitypackage -C "$WORK/pkg"
for d in "$WORK"/pkg/*/; do
  [ -f "$d/asset" ] || continue
  p=$(tr -d '\r' < "$d/pathname" | head -1)
  if cmp -s "$d/asset" "$ROOT/measure/unity/$p"; then echo "same     $p"; else echo "updated  $p"; fi
  cp "$ROOT/measure/unity/$p" "$d/asset"
done
( cd "$WORK/pkg" && tar --force-local -czf "$OUT/Paramroom-unity-$V.unitypackage" --owner=0 --group=0 * )

# 文書は CRLF にする（メモ帳で読まれる）
crlf() { tr -d '\r' < "$1" | sed 's/$/\r/' > "$2"; }
crlf "$ROOT/LICENSE" "$OUT/LICENSE"
crlf "$ROOT/THIRD-PARTY-NOTICES.txt" "$OUT/THIRD-PARTY-NOTICES.txt"
crlf "$ROOT/docs/booth/zip-README.txt" "$OUT/README.txt"

# BOOTH 用の zip（無料版・支援版の両方にこれを付ける）
powershell -NoProfile -Command "Compress-Archive -Force -DestinationPath '$OUT/Paramroom-$V.zip' -Path '$OUT/Paramroom-unity-$V.unitypackage','$OUT/Paramroom.App.exe','$OUT/LICENSE','$OUT/THIRD-PARTY-NOTICES.txt','$OUT/README.txt'"
rm -rf "$WORK"
ls -la "$OUT"
