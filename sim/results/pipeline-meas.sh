#!/bin/bash
cd /d/work/ClaudeCode/avatar-image-pad/sim
node run.js --grid mselect --imagedir ref-train --codecs pw,prim,wavl,dctv,pal,raw --exclude "n5000|n2500" --out results/mselect.jsonl > results/mselect.log 2>&1
node aggregate.js select results/mselect.jsonl --top 1 --out results/mselected.json > results/mselect.txt
node run.js --grid mfull --imagedir ref --selected results/mselected.json --crc 0,8 --out results/mfull.jsonl > results/mfull.log 2>&1
echo "meas pipeline done: $(tail -1 results/mselect.log) / $(tail -1 results/mfull.log)"
