#!/bin/bash
cd /d/work/ClaudeCode/avatar-image-pad/sim
OUT="C:/Users/kumom/AppData/Local/Temp/claude/D--work-ClaudeCode-avatar-image-pad/036d1995-5e90-4e51-ba73-946788bf3783/tasks/bru90lx7i.output"
until grep -q "crc32 done" "$OUT" 2>/dev/null; do sleep 30; done
node run.js --grid select --imagedir ref-train --codecs raw --out results/select.jsonl --append > results/select-raw.log 2>&1
node aggregate.js select results/select.jsonl --top 1 --out results/selected-all2.json > results/select-all2.txt
node -e "const a=require('./results/selected-all2.json');require('fs').writeFileSync('results/selected-raw.json',JSON.stringify(a.filter(x=>x.codec==='raw'),null,1))"
node run.js --grid full --imagedir ref --selected results/selected-raw.json --crc 0,8 --out results/full-raw.jsonl > results/full-raw.log 2>&1
node run.js --grid latejoin --imagedir ref --selected results/selected-raw.json --crc 0 --out results/latejoin.jsonl --append > results/latejoin-raw.log 2>&1
echo "raw pipeline done: $(tail -1 results/full-raw.log) / $(tail -1 results/latejoin-raw.log)"
