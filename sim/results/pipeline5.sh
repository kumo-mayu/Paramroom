#!/bin/bash
cd /d/work/ClaudeCode/avatar-image-pad/sim
OUT="C:/Users/kumom/AppData/Local/Temp/claude/D--work-ClaudeCode-avatar-image-pad/036d1995-5e90-4e51-ba73-946788bf3783/tasks/bmzj3vjo4.output"
until grep -q "dual pipeline done" "$OUT" 2>/dev/null; do sleep 30; done
node -e "const a=require('./results/selected-all3.json');require('fs').writeFileSync('results/selected-top.json',JSON.stringify(a.filter(x=>['pw','wavl','prim'].includes(x.codec)),null,1))"
node run.js --grid latejoin2 --imagedir ref --selected results/selected-top.json --crc 0 --out results/latejoin2.jsonl > results/latejoin2.log 2>&1
echo "latejoin2 done: $(tail -1 results/latejoin2.log)"
