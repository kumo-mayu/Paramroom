'use strict';
// Scenario matrix: AUC (log-time, msssimc) per codec x scenario, per B. Averaged over seeds then images.
// usage: node summary.js results/full.jsonl [--metric msssimc] [--cap 90] [--t 5] [--cat photo] [--markdown]
const fs = require('fs');
const args = {};
const files = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const n = process.argv[i + 1]; if (n === undefined || n.startsWith('--')) args[a.slice(2)] = true; else { args[a.slice(2)] = n; i++; } }
  else files.push(a);
}
const metric = args.metric || 'msssimc';
const cap = Number(args.cap || 90);
const TIMES = [1, 2, 5, 10, 20, 40, 60];
const cat = img => (img.startsWith('kodim') ? 'photo' : img.startsWith('illust') ? 'illust' : 'screenshot');

const SCEN = [
  ['基準 bm14', r => r.ch === 'bm14' && r.policy === 'carousel' && r.join === 0 && r.crc === 0],
  ['楽観 nom117', r => r.ch === 'nom117' && r.policy === 'carousel' && r.join === 0 && r.crc === 0],
  ['bm12(16%欠)', r => r.ch === 'bm12' && r.policy === 'carousel' && r.join === 0 && r.crc === 0],
  ['bm20', r => r.ch === 'bm20' && r.policy === 'carousel' && r.join === 0 && r.crc === 0],
  ['カリング', r => r.ch === 'bm14cull' && r.policy === 'carousel' && r.join === 0 && r.crc === 0],
  ['半端pkt', r => r.ch === 'bm14torn' && r.policy === 'carousel' && r.join === 0 && r.crc === 0],
  ['半端+CRC', r => r.ch === 'bm14torn' && r.policy === 'carousel' && r.join === 0 && r.crc > 0],
  ['途中参加30s', r => r.ch === 'bm14' && r.policy === 'carousel' && r.join === 30 && r.crc === 0],
  ['途中+prio', r => r.ch === 'bm14' && r.policy === 'prio' && r.join === 30 && r.crc === 0],
];

const acc = new Map(); // key codec|B|cfg|scen -> image -> t -> {s,n}
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start); if (end < 0) end = text.length;
    const line = text.slice(start, end); start = end + 1;
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.cap !== cap) continue;
    if (args.cat && cat(r.image) !== args.cat) continue;
    SCEN.forEach(([name, fn], si) => {
      if (!fn(r)) return;
      const k = `${r.codec}|${r.B}|${r.cfg}|${si}`;
      let m = acc.get(k); if (!m) acc.set(k, (m = new Map()));
      let byT = m.get(r.image); if (!byT) m.set(r.image, (byT = new Map()));
      let a = byT.get(r.t); if (!a) byT.set(r.t, (a = { s: 0, n: 0 }));
      a.s += r[metric]; a.n++;
    });
  }
}
function curve(m) {
  const v = TIMES.map(() => 0); let n = 0;
  for (const byT of m.values()) {
    const c = TIMES.map(t => (byT.get(t) ? byT.get(t).s / byT.get(t).n : NaN));
    if (c.some(Number.isNaN)) continue;
    c.forEach((x, i) => (v[i] += x)); n++;
  }
  return { v: v.map(x => x / n), n };
}
function auc(v) {
  let s = 0;
  for (let i = 1; i < TIMES.length; i++) s += (v[i] + v[i - 1]) / 2 * Math.log(TIMES[i] / TIMES[i - 1]);
  return s / Math.log(60);
}
const rows = new Map();
for (const [k, m] of acc) {
  const [codec, B, cfg, si] = k.split('|');
  const rk = `${B}|${codec}|${cfg}`;
  if (!rows.has(rk)) rows.set(rk, {});
  const c = curve(m);
  const tSel = args.t ? Number(args.t) : null;
  rows.get(rk)[si] = { val: tSel ? c.v[TIMES.indexOf(tSel)] : auc(c.v), n: c.n };
}
const f3 = x => (x === undefined ? '  -  ' : metric === 'psnr' ? x.toFixed(1) : x.toFixed(3));
const Bs = [...new Set([...rows.keys()].map(k => +k.split('|')[0]))].sort((a, b) => b - a);
const label = args.t ? `t=${args.t}s の ${metric}` : `対数時間AUC(${metric})`;
for (const B of Bs) {
  const list = [...rows.entries()].filter(([k]) => +k.split('|')[0] === B)
    .sort((a, b) => (b[1][0]?.val ?? 0) - (a[1][0]?.val ?? 0));
  console.log(`\n### B=${B} bit — ${label}, cap=${cap}s${args.cat ? ', ' + args.cat : ''}\n`);
  console.log('| 方式 | 設定 | ' + SCEN.map(s => s[0]).join(' | ') + ' |');
  console.log('|---|---|' + SCEN.map(() => '---:').join('|') + '|');
  for (const [k, r] of list) {
    const [, codec, cfg] = k.split('|');
    console.log(`| ${codec} | ${cfg} | ` + SCEN.map((_, si) => f3(r[si]?.val)).join(' | ') + ' |');
  }
}
