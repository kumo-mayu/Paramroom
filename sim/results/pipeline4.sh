#!/bin/bash
cd /d/work/ClaudeCode/avatar-image-pad/sim
OUT="C:/Users/kumom/AppData/Local/Temp/claude/D--work-ClaudeCode-avatar-image-pad/036d1995-5e90-4e51-ba73-946788bf3783/tasks/b476c8xbc.output"
until grep -q "raw pipeline done" "$OUT" 2>/dev/null; do sleep 30; done
node run.js --grid select --imagedir ref-train --codecs dual --out results/select.jsonl --append > results/select-dual.log 2>&1
node aggregate.js select results/select.jsonl --top 1 --out results/selected-all3.json > results/select-all3.txt
node -e "const a=require('./results/selected-all3.json');require('fs').writeFileSync('results/selected-dual.json',JSON.stringify(a.filter(x=>x.codec==='dual'),null,1))"
node run.js --grid full --imagedir ref --selected results/selected-dual.json --crc 0,8 --out results/full-dual.jsonl > results/full-dual.log 2>&1
node run.js --grid latejoin --imagedir ref --selected results/selected-dual.json --crc 0 --out results/latejoin.jsonl --append > results/latejoin-dual.log 2>&1
echo "dual pipeline done: $(tail -1 results/select-dual.log) / $(tail -1 results/full-dual.log) / $(tail -1 results/latejoin-dual.log)"
