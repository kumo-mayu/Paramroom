#!/bin/bash
cd /d/work/ClaudeCode/avatar-image-pad/sim
until ! powershell -NoProfile -Command "if ((Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*run.js*' })) { exit 0 } else { exit 1 }"; do sleep 30; done
echo "select-hyb done: $(tail -1 results/select-hyb.log)"
node aggregate.js select results/select.jsonl --top 1 --out results/selected-all.json > results/select-all.txt
node -e "const a=require('./results/selected-all.json');require('fs').writeFileSync('results/selected-hyb.json',JSON.stringify(a.filter(x=>['pw','palq','tile'].includes(x.codec)),null,1))"
node run.js --grid full --imagedir ref --selected results/selected-hyb.json --crc 0,8 --out results/full-hyb.jsonl > results/full-hyb.log 2>&1
echo "full-hyb done: $(tail -1 results/full-hyb.log)"
node run.js --grid latejoin --imagedir ref --selected results/selected-all.json --crc 0 --out results/latejoin.jsonl > results/latejoin.log 2>&1
echo "latejoin done: $(tail -1 results/latejoin.log)"
node run.js --grid crc32 --imagedir ref --selected results/selected-all.json --budgets 32 --crc 0,4 --out results/crc32.jsonl > results/crc32.log 2>&1
echo "crc32 done: $(tail -1 results/crc32.log)"
