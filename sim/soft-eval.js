'use strict';
// Does a softer (stepped) primitive edge buy anything at the same bit cost? (docs/research/07)
// The primitive fields stay exactly as they are; only the way a primitive is painted changes: instead of one hard
// ellipse, the pixel weight falls in 2-3 steps with the squared ellipse distance q (cfg.soft = [[q, w], ...]).
// A shader can do this with a few compares, so it costs no parameter bits and no store texels.
//   node soft-eval.js encode <image> <profile> [R] [n]  -> cache/soft/<image>-<profile>-r<R>-n<n>.json
//   node soft-eval.js eval   <image> <profile> [R] [n]  -> results/softprim.jsonl (full quality + prefix quality)
//   node soft-eval.js summary                           -> results/softprim.md
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const M = require('./lib/metrics');
const primx = require('./codecs/primx');
const { padBits } = require('./lib/evaluate');

const P = 254;
// Profiles: q is the squared ellipse distance (q <= 1 is today's shape), w the weight applied to alpha there.
// "in" profiles keep the same outer extent and soften inwards; "out" profiles add a fainter ring outside it.
const PROFILES = {
  hard: null,
  in2: [[0.5, 1], [1, 0.5]],
  in3: [[0.35, 1], [0.7, 0.62], [1, 0.28]],
  out2: [[1, 1], [1.7, 0.45]],
  out3: [[0.6, 1], [1.2, 0.55], [2, 0.22]],
  gauss3: [[0.45, 1], [1.1, 0.5], [2.2, 0.16]],
};
// prefix fractions of the units (the send order is the same for every profile, so a prefix compares fairly)
const FRACS = [0.05, 0.15, 0.4, 1];

const cacheDir = path.join(__dirname, 'cache', 'soft');
const outFile = path.join(__dirname, 'results', 'softprim.jsonl');
const [cmd, image, profile, Rs = '512', ns = '4000'] = process.argv.slice(2);
const R = Number(Rs), n = Number(ns);
const cfgFor = p => ({ ...primx.cfgOf({ shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, R, maxPrims: n, soft: PROFILES[p] }), out: R });
const cacheFile = (img = image, p = profile) => path.join(cacheDir, `${img}-${p}-r${R}-n${n}.json`);
const refOf = img => I.loadPNG(path.join(__dirname, 'images', 'ref' + R, img + '.png'));

if (cmd === 'encode') {
  if (!(profile in PROFILES)) throw new Error('unknown profile: ' + profile);
  fs.mkdirSync(cacheDir, { recursive: true });
  const cfg = cfgFor(profile);
  const t0 = Date.now();
  const enc = primx.encode(refOf(image), cfg, P);
  fs.writeFileSync(cacheFile(), JSON.stringify({
    image, profile, R, n, encSec: (Date.now() - t0) / 1000,
    units: enc.units.map(u => padBits(u, P).join('')), gains: enc.gains,
  }));
  console.log(`${image} ${profile}: ${enc.units.length} units, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} else if (cmd === 'eval') {
  const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  const cfg = cfgFor(profile);
  const units = c.units.map(s => [...s].map(Number));
  const ref = refOf(image);
  // greedy order = the order the encoder produced; a prefix is "the first f of the units, best ones first"
  const order = c.gains.map((g, i) => [i, g === null ? Infinity : g]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const rows = [];
  for (const f of FRACS) {
    const k = Math.max(1, Math.round(units.length * f));
    const dec = primx.decoder(cfg, P);
    for (const u of order.slice(0, k)) dec.apply(units[u]);
    rows.push({ image, profile, R, n, N: units.length, encSec: c.encSec, frac: f, units: k, q: +M.all(ref, dec.render()).msssimc.toFixed(4) });
  }
  fs.appendFileSync(outFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(rows.map(r => `${r.image} ${r.profile} f=${r.frac}: ${r.q}`).join('\n'));
} else if (cmd === 'summary') {
  const rows = fs.readFileSync(outFile, 'utf8').trim().split('\n').map(JSON.parse);
  const images = [...new Set(rows.map(r => r.image))];
  const profs = [...new Set(rows.map(r => r.profile))];
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const get = (p, f) => rows.filter(r => r.profile === p && r.frac === f);
  const lines = ['# 図形の輪郭をぼかした場合（ビット数は現行と同じ）', '',
    `画像 ${images.length} 枚、キャンバス ${rows[0].R}、図形 ${rows[0].n} 個。MS-SSIM (YCbCr 6:1:1)。`,
    '手前の f は「誤差削減の大きいユニットから順に f 割合だけ届いた状態」。', '',
    '| 形 | ' + FRACS.map(f => `f=${f}`).join(' | ') + ' | 符号化時間 |', '|---|' + FRACS.map(() => '---:').join('|') + '|---:|'];
  for (const p of profs) {
    const cells = FRACS.map(f => { const g = get(p, f); return g.length ? mean(g.map(r => r.q)).toFixed(4) : '-'; });
    const t = get(p, 1);
    lines.push(`| ${p} | ${cells.join(' | ')} | ${t.length ? mean(t.map(r => r.encSec)).toFixed(0) + ' s' : '-'} |`);
  }
  lines.push('', '## 画像ごと（全部届いたとき）', '', '| 画像 | ' + profs.join(' | ') + ' |', '|---|' + profs.map(() => '---:').join('|') + '|');
  for (const img of images) {
    lines.push(`| ${img} | ` + profs.map(p => { const r = rows.find(x => x.image === img && x.profile === p && x.frac === 1); return r ? r.q.toFixed(4) : '-'; }).join(' | ') + ' |');
  }
  lines.push('', '各形の定義（q = 楕円距離の二乗、w = そこでの重み）：', '',
    ...Object.entries(PROFILES).map(([k, v]) => `- \`${k}\`: ${v ? v.map(([q, w]) => `q≤${q} → ${w}`).join('、') : '現行（q≤1 → 1）'}`), '');
  const out = path.join(__dirname, 'results', 'softprim.md');
  fs.writeFileSync(out, lines.join('\n'));
  console.log(lines.join('\n'));
} else {
  console.log('usage: node soft-eval.js encode|eval|summary <image> <profile> [R] [n]');
}
