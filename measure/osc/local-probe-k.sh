#!/usr/bin/env bash
# One probe avatar, the standard battery (docs/research/12). The avatar must already be worn.
#   bash local-probe-k.sh <K> <rate> [<rate> ...]
# idle fps; fps with constant non-zero values; then for each rate:
#   p1 = share of 2048 chunks present after ONE pass (two runs), fps during a ~10 s transfer,
#   throughput = rate x groups x 868 bit x p1.
# One JSON line per measurement.
cd "$(dirname "$0")"
K=$1; shift
G=$((K / 32))
win() {  # fps over a window of $1 seconds from two overlay reads
  local A B; A=$(node local-probe-read.js); sleep "$1"; B=$(node local-probe-read.js)
  node -e "const a=$A,b=$B; console.log(JSON.stringify({fps:+((b.frames-a.frames)/(b.nowMs-a.nowMs)*1000).toFixed(1), rejected:b.rejected-a.rejected, err:a.frameErrors+b.frameErrors}))"
}
echo "{\"k\":$K,\"what\":\"idle\",\"r\":$(win 8)}"
node local-probe.js flood --mode same --groups $G --rate 30 --seconds 14 >/dev/null &
sleep 4; echo "{\"k\":$K,\"what\":\"same30\",\"r\":$(win 8)}"; wait
sleep 1
for r in "$@"; do
  P1=""
  for rep in 1 2; do
    node local-probe.js run --k $K --chunks 2048 --rate $r --passes 1 --tail 600 >/dev/null
    P1="$P1$(node local-probe-read.js | node -e "const s=JSON.parse(require('fs').readFileSync(0));process.stdout.write(JSON.stringify({p:s.present/2048,c:s.correct,rej:s.rejectedShare,err:s.frameErrors}))"),"
  done
  P=$(( (r * 11 * G + 2047) / 2048 )); [ $P -lt 1 ] && P=1
  node local-probe.js run --k $K --chunks 2048 --rate $r --passes $P --tail 300 >/dev/null &
  sleep 3; W=$(win 6); wait
  node -e "const p=[${P1%,}], w=$W; const p1=p.reduce((a,x)=>a+x.p,0)/p.length;
    console.log(JSON.stringify({k:$K, what:'transfer', rate:$r, groups:$G, p1:p.map(x=>+x.p.toFixed(3)), fpsDuring:w.fps,
      kbps:Math.round($r*$G*868*p1/1000), correctOk:p.every(x=>x.c===Math.round(x.p*2048)), rejShare:p.map(x=>x.rej), err:p.reduce((a,x)=>a+x.err,0)+w.err}))"
  sleep 1
done
