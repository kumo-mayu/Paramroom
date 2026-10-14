#!/bin/bash
# ShotLink（写真に写った QR を PC で受け取るアプリ。Paramroom のおまけ）の配布物を取ってきて、
# 出力先にフォルダのまま展開する。展開したフォルダ名（ShotLink-v1.0.0 など）を標準出力に出す。
#
#   bash tools/release/fetch-shotlink.sh latest D:/work/ClaudeCode/Paramroom-release/v0.2.3
#   bash tools/release/fetch-shotlink.sh v1.0.0 <出力先>
#   SHOTLINK_ZIP=<手元の ShotLink-v1.0.0.zip> bash tools/release/fetch-shotlink.sh latest <出力先>   # 試すとき
#
# exe だけでなくフォルダごと入れる。ShotLink 自身の LICENSE と、exe に入る .NET・Microsoft の部品の
# 許諾文（THIRD-PARTY-NOTICES.txt）を添えて配る義務があるため。
# ShotLink を更新するたびに Paramroom を差し替えはしない。Paramroom の版を出すときに、その時点の最新を入れる
# （ShotLink の仕様書 11章）。公開済みの版だけを取る（下書きは latest にならない）。
set -euo pipefail
TAG=${1:?取る版（latest か v1.0.0 など）}; OUT=${2:?出力先}
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

if [ -n "${SHOTLINK_ZIP:-}" ]; then
  cp "$SHOTLINK_ZIP" "$WORK/"
  [ -f "$SHOTLINK_ZIP.sha256" ] && cp "$SHOTLINK_ZIP.sha256" "$WORK/"
else
  if [ "$TAG" = latest ]; then TAG=""; fi
  # 進み具合の表示を標準出力に混ぜない（呼ぶ側はフォルダ名だけを受け取る）
  gh release download $TAG --repo kumo-mayu/shotlink --pattern 'ShotLink-v*.zip*' --dir "$WORK" >&2
fi

ZIP=$(ls "$WORK"/ShotLink-v*.zip | head -1)
# 配った物と同じ zip かを、ShotLink の組み立てが添えたハッシュで確かめる
if [ -f "$ZIP.sha256" ]; then
  ( cd "$WORK" && tr -d '\r' < "$(basename "$ZIP").sha256" | sha256sum -c --status ) \
    || { echo "ShotLink の zip のハッシュが合わない: $ZIP" >&2; exit 1; }
else
  echo "ShotLink の zip に .sha256 が無いので、ハッシュは確かめていない" >&2
fi

unzip -q -o "$ZIP" -d "$WORK/x"
DIR=$(basename "$(ls -d "$WORK"/x/ShotLink-v*/ | head -1)")
# 中身が ShotLink の配る形（4つ）か。足りない物があれば、組み立てが崩れた版を入れようとしている
for f in ShotLink.exe README.txt LICENSE THIRD-PARTY-NOTICES.txt; do
  [ -f "$WORK/x/$DIR/$f" ] || { echo "ShotLink の zip に $f が無い: $ZIP" >&2; exit 1; }
done

rm -rf "${OUT:?}/$DIR"
mkdir -p "$OUT"
cp -r "$WORK/x/$DIR" "$OUT/"
echo "$DIR"
