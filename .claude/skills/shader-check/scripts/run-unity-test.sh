#!/usr/bin/env bash
# Unity の batchmode で受信側（シェーダー・プレハブ生成）を実際に動かす。
#
#   bash run-unity-test.sh <Unity プロジェクト> <試験名> [テストデータ名] [追加の引数...]
#     試験名: shader | qr | build
#
# 例:
#   bash run-unity-test.sh "$SCRATCH/unitytest" shader prim-kodim23
#   bash run-unity-test.sh "$SCRATCH/unitytest" shader prim-kodim23 -paramroomHold 2
#   bash run-unity-test.sh "$SCRATCH/unitytest" qr qronly-25x25-4int
#   bash run-unity-test.sh "$SCRATCH/unitytest" build
#
# リポジトリの Assets をプロジェクトへ写してから走らせるので、直した内容が必ず反映される。
set -e
UNITY=${PARAMROOM_UNITY:-"/c/Program Files/Unity/Hub/Editor/2022.3.22f1/Editor/Unity.exe"}
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)

PROJ=$1; KIND=$2; DATA=$3
[ -n "$PROJ" ] && [ -n "$KIND" ] || { echo "usage: run-unity-test.sh <proj> <shader|qr|build> [data] [extra args]"; exit 1; }
[ -d "$PROJ/Assets" ] || { echo "Unity プロジェクトが見つかりません: $PROJ"; exit 1; }
[ -x "$UNITY" ] || { echo "Unity が見つかりません: $UNITY（PARAMROOM_UNITY で指定できます）"; exit 1; }
shift 3 2>/dev/null || shift $#

# 1. リポジトリの中身を写す（配布する部品と、検証用の試験・テストデータ）
rm -rf "$PROJ/Assets/kumo-mayu" "$PROJ/Assets/ParamroomMeasure"
mkdir -p "$PROJ/Assets/kumo-mayu"
cp -r "$REPO/measure/unity/Assets/kumo-mayu/Paramroom" "$PROJ/Assets/kumo-mayu/Paramroom"
cp -r "$REPO/measure/unity/Assets/ParamroomMeasure" "$PROJ/Assets/ParamroomMeasure"

case "$KIND" in
  shader) METHOD=ParamroomShaderTest.Run;   NOGFX="" ;;
  qr)     METHOD=ParamroomQrShaderTest.Run; NOGFX="" ;;
  build)  METHOD=ParamroomQrBuildTest.Run;  NOGFX="-nographics" ;;
  *) echo "試験名は shader / qr / build のどれか"; exit 1 ;;
esac

# Unity は "-paramroomOut ../x" のような相対の親を嫌うので、絶対パスに直しておく
PARENT=$(cd "$PROJ/.." && pwd)
OUT="$PARENT/paramroom-test-out"
LOG="$PARENT/paramroom-test-$KIND.log"
mkdir -p "$OUT"
ARGS=(-batchmode $NOGFX -projectPath "$PROJ" -executeMethod "$METHOD" -paramroomOut "$OUT" -logFile "$LOG")
[ -n "$DATA" ] && ARGS+=(-paramroomData "$DATA")
ARGS+=("$@")

set +e
"$UNITY" "${ARGS[@]}"
CODE=$?
set -e

echo "--- 終了コード $CODE / ログ $LOG"
grep -E "\[Paramroom\]|\[QrShaderTest\]|\[QrBuildTest\]" "$LOG" | grep -v "^ *at \|UnityEngine\.\|(Filename:" || true
if grep -q "error CS" "$LOG"; then
  echo "--- コンパイルエラー"
  grep "error CS" "$LOG" | head -5
fi
exit $CODE
