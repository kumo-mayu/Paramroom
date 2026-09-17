'use strict';
// Late-join (random join 20..80 s) summary: AUC(log t) of msssimc and values at t=5,20 per codec x policy.
// usage: node latejoin-summary.js results/latejoin.jsonl [results/latejoin2.jsonl ...] [--codecs a,b]
const fs = require('fs');
const ci0 = process.argv.indexOf('--codecs');
const files = process.argv.slice(2).filter((a, i) => !a.startsWith('--') && i + 2 !== ci0 + 1);
const ci = process.argv.indexOf('--codecs');
const only = ci > 0 ? process.argv[ci + 1].split(',') : null;
const TIMES = [1, 2, 5, 10, 20, 40, 60];
const acc = new Map();
for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
  if (!line) continue;
  const r = JSON.parse(line);
  if (r.join === 0) continue;
  if (only && !only.includes(r.codec)) continue;
  const k = [r.B, r.cap, r.codec, r.policy].join('|');
  let m = acc.get(k); if (!m) acc.set(k, m = new Map());
  let bt = m.get(r.image); if (!bt) m.set(r.image, bt = new Map());
  let a = bt.get(r.t); if (!a) bt.set(r.t, a = { s: 0, n: 0 });
  a.s += r.msssimc; a.n++;
}
const groups = {};
for (const [k, m] of acc) {
  const v = TIMES.map(() => 0); let n = 0;
  for (const bt of m.values()) { TIMES.forEach((t, i) => (v[i] += bt.get(t).s / bt.get(t).n)); n++; }
  const c = v.map(x => x / n);
  let s = 0; for (let i = 1; i < 7; i++) s += (c[i] + c[i - 1]) / 2 * Math.log(TIMES[i] / TIMES[i - 1]);
  const [B, cap, codec, pol] = k.split('|');
  (groups[`${B}|${cap}`] = groups[`${B}|${cap}`] || []).push({ codec, pol, auc: s / Math.log(60), t5: c[2], t20: c[4] });
}
for (const g of Object.keys(groups).sort((a, b) => b.split('|')[0] - a.split('|')[0] || a.split('|')[1] - b.split('|')[1])) {
  const [B, cap] = g.split('|');
  console.log(`\n### B=${B}, 周回上限 ${cap}s（ランダム途中参加、AUC / t=5s / t=20s）\n`);
  console.log('| 方式 | 送信方式 | AUC | 5s | 20s |\n|---|---|---:|---:|---:|');
  for (const r of groups[g].sort((a, b) => b.auc - a.auc)) console.log(`| ${r.codec} | ${r.pol} | ${r.auc.toFixed(3)} | ${r.t5.toFixed(3)} | ${r.t20.toFixed(3)} |`);
}
