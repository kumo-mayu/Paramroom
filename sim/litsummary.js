'use strict';
// Summary of the 'lit' grid: AUC (log time, msssimc) per codec x policy, start vs late join, per cap.
const fs = require('fs');
const TIMES = [1, 2, 5, 10, 20, 40, 60];
const acc = new Map();
for (const line of fs.readFileSync(process.argv[2], 'utf8').split('\n')) {
  if (!line) continue;
  const r = JSON.parse(line);
  const k = [r.B, r.cap, r.codec + (r.cfg.endsWith('-cc') ? '(補間)' : ''), r.policy, r.join === 0 ? 'start' : 'late'].join('|');
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
const pols = ['carousel', 'tier', 'prio4b8', 'sqrt', 'sqrt30', 'sqrt60'];
for (const cap of [30, 90]) for (const B of [256, 128, 64, 32]) {
  const codecs = [...new Set([...val.keys()].filter(k => k.startsWith(`${B}|${cap}|`)).map(k => k.split('|')[2]))];
  console.log(`\n### B=${B}bit・周回上限 ${cap}秒（上段: 開始時から視聴 / 下段: 途中参加、AUC）\n`);
  console.log('| 方式 | 視聴 | ' + pols.join(' | ') + ' |');
  console.log('|---|---|' + pols.map(() => '---:').join('|') + '|');
  for (const c of codecs) for (const j of ['start', 'late']) {
    const row = pols.map(p => val.get([B, cap, c, p, j].join('|')));
    const best = Math.max(...row.map(x => (x ? x.auc : 0)));
    console.log(`| ${c} | ${j === 'start' ? '開始時' : '途中参加'} | ` + row.map(x => (x ? (x.auc === best ? `**${x.auc.toFixed(3)}**` : x.auc.toFixed(3)) : '-')).join(' | ') + ' |');
  }
}
