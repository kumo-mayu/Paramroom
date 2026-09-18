#!/bin/sh
# Reduced-precision prim variants (32 Int, canvas 512) encoded with the C# encoder for all test images.
# name:cb:rb:ab:col:aBits:n
cd "$(dirname "$0")/../.."
B=tools/ParamroomTool/bin/Release/net9.0/paramroom.exe
for v in A:9:8:6:5,6,5:2:4000 C:8:6:5:4,4,4:2:4000 C:8:6:5:4,4,4:2:5000 E:9:7:5:3,3,3:1:4000 E:9:7:5:3,3,3:1:5000 F:8:8:6:3,3,2:1:4000 F:8:8:6:3,3,2:1:5000 G:7:6:4:3,3,2:1:4000 G:7:6:4:3,3,2:1:6000 H:8:6:4:2,2,2:1:4000 H:8:6:4:2,2,2:1:6000; do
  for f in sim/images/ref512/*.png; do echo "$v $f"; done
done | xargs -P 4 -L 1 sh -c 'IFS=: read name cb rb ab col abits n <<X
$0
X
img=$(basename $1 .png); out=sim/cache/precision/$img-$name-n$n.json; [ -f $out ] || '"$B"' encode $1 --R 512 --n $n --cb $cb --rb $rb --ab $ab --col $col --abits $abits --out $out > /dev/null'
echo done
