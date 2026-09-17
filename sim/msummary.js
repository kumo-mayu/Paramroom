'use strict';
// Summary for the measured-channel grid (mfull): AUC (log time, msssimc) per codec for key scenarios.
// usage: node msummary.js results/mfull.jsonl [--cap 30|90]
const fs = require('fs');
const file = process.argv[2];
const ci = process.argv.indexOf('--cap');
const cap = ci > 0 ? Number(process.argv[ci + 1]) : 90;
const TIMES = [1, 2, 5, 10, 20, 40, 60];
const acc = new Map();
const text = fs.readFileSync(file, 'utf8');
let start = 0;
while (start < text.length) {
  let end = text.indexOf('\n', start); if (end < 0) end = text.length;
  const line = text.slice(start, end); start = end + 1;
  if (!line) continue;
  const r = JSON.parse(line);
  if (r.cap !== cap) continue;
  const k = [r.B, r.codec, r.cfg, r.ch, r.crc, r.join === 0 ? 'start' : 'late', r.policy].join('|');
  let m = acc.get(k); if (!m) acc.set(k, (m = new Map()));
  let bt = m.get(r.image); if (!bt) m.set(r.image, (bt = new Map()));
  let a = bt.get(r.t); if (!a) bt.set(r.t, (a = { s: 0, n: 0 }));
  a.s += r.msssimc; a.n++;
}
const val = new Map();
for (const [k, m] of acc) {
  const v = TIMES.map(() => 0); let n = 0;
  for (const bt of m.values()) { TIMES.forEach((t, i) => (v[i] += bt.get(t).s / bt.get(t).n)); n++; }
  const c = v.map(x => x / n);
  let s = 0; for (let i = 1; i < 7; i++) s += (c[i] + c[i - 1]) / 2 * Math.log(TIMES[i] / TIMES[i - 1]);
  val.set(k, { auc: s / Math.log(60), t5: c[2], t60: c[6] });
}
const get = (B, codec, cfg, ch, crc, join, pol) => val.get([B, codec, cfg, ch, crc, join, pol].join('|'));
const combos = [...new Set([...val.keys()].map(k => k.split('|').slice(0, 3).join('|')))];
const f = x => (x ? x.auc.toFixed(3) : '  -  ');
for (const B of [256, 128, 64, 32]) {
  const list = combos.filter(c => +c.split('|')[0] === B).map(c => c.split('|'));
  list.sort((a, b) => (get(...b, 'm100b', 0, 'start', 'carousel')?.auc || 0) - (get(...a, 'm100b', 0, 'start', 'carousel')?.auc || 0));
  console.log(`\n### B=${B} bit（実測チャネル、周回上限 ${cap} 秒、MS-SSIM(色差込み) 対数時間 AUC）\n`);
  console.log('| 方式 | 開始時・保持100ms・バンドル | 保持83ms | 保持117ms | 個別送信（半端6%） | 個別送信＋CRC-8 | 5秒時点 | 60秒時点 | 途中参加 carousel | 途中参加 tier | 途中参加 prio4b8 | 開始時 prio4b8 |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [b, codec, cfg] of list) {
    const base = get(b, codec, cfg, 'm100b', 0, 'start', 'carousel');
    console.log(`| ${codec} | ${f(base)} | ${f(get(b, codec, cfg, 'm083b', 0, 'start', 'carousel'))} | ${f(get(b, codec, cfg, 'm117b', 0, 'start', 'carousel'))} | ${f(get(b, codec, cfg, 'm100i', 0, 'start', 'carousel'))} | ${f(get(b, codec, cfg, 'm100i', 8, 'start', 'carousel'))} | ${base ? base.t5.toFixed(3) : '-'} | ${base ? base.t60.toFixed(3) : '-'} | ${f(get(b, codec, cfg, 'm100b', 0, 'late', 'carousel'))} | ${f(get(b, codec, cfg, 'm100b', 0, 'late', 'tier'))} | ${f(get(b, codec, cfg, 'm100b', 0, 'late', 'prio4b8'))} | ${f(get(b, codec, cfg, 'm100b', 0, 'start', 'prio4b8'))} |`);
  }
}
