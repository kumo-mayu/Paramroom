'use strict';
// Compares 512-canvas and 1024-canvas encodings on the same footing (docs/research/08 §17).
// A render is only comparable to another if both are judged against the same reference, so every render is put on both
// scales: downscaled to 512 (what a viewer sees from a normal distance) and upscaled/native at 1024 (what a viewer sees
// when they walk up to the picture).
//   node big-compare.js <image> [variants...]   -> results/bigcompare.jsonl
//   node big-compare.js summary
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const M = require('./lib/metrics');
const primx = require('./codecs/primx');
const SHAPE = require('./lib/shape-variants');

const P = 254;
const out = path.join(__dirname, 'results', 'bigcompare.jsonl');
const cacheDir = path.join(__dirname, 'cache', 'shape');
const KS = [150, 400, 1001];
const [image, ...vars] = process.argv.slice(2);

if (image === 'summary') {
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  const imgs = [...new Set(rows.map(r => r.image))];
  const vs = [...new Set(rows.map(r => r.variant))];
  const lines = ['# 512 キャンバスと 1024 キャンバスの比較（同じ土俵）', '',
    '1024 の描画は 512 に縮小して 512 参照と、512 の描画は 1024 に拡大して 1024 参照と比べている。',
    'q512 = 離れて見たときの見え方、q1024 = 近づいて見たときの見え方。パケット数はどちらも 1001 個。', ''];
  for (const im of imgs) {
    lines.push(`## ${im}`, '', '| 表現 | キャンバス | ' + KS.map(k => `q512 ${k}p`).join(' | ') + ' | ' + KS.map(k => `q1024 ${k}p`).join(' | ') + ' |',
      '|---|---|' + KS.map(() => '---:').join('|') + '|' + KS.map(() => '---:').join('|') + '|');
    for (const v of vs) {
      const r = KS.map(k => rows.find(x => x.image === im && x.variant === v && x.k === k));
      if (!r[0]) continue;
      lines.push(`| ${v} | ${r[0].R} | ` + r.map(x => x.q512.toFixed(4)).join(' | ') + ' | ' + r.map(x => x.q1024.toFixed(4)).join(' | ') + ' |');
    }
    lines.push('');
  }
  const p = path.join(__dirname, 'results', 'bigcompare.md');
  fs.writeFileSync(p, lines.join('\n'));
  console.log(lines.join('\n'));
  return;
}

const ref512 = I.loadPNG(path.join(__dirname, 'images', 'ref512', image + '.png'));
const ref1024 = I.loadPNG(path.join(__dirname, 'images', 'ref1024', image + '.png'));
const rows = [];
for (const v of vars) {
  const R = SHAPE.VARIANTS[v].cb >= 10 ? 1024 : 512;
  const file = path.join(cacheDir, `${image}-${v}${R === 512 ? '' : '-r' + R}.json`);
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = SHAPE.cfgFor(v, R, P);
  const units = c.units.map(s => [...s].map(Number));
  const order = c.gains.map((g, i) => [i, g === null ? Infinity : g]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  for (const k of KS) {
    const dec = primx.decoder(cfg, P);
    for (const u of order.slice(0, Math.min(k, units.length))) dec.apply(units[u]);
    const img = dec.render();
    const a512 = R === 512 ? img : I.resize(img, 512, 512);
    const a1024 = R === 1024 ? img : I.resize(img, 1024, 1024);
    rows.push({ image, variant: v, R, k, q512: +M.all(ref512, a512).msssimc.toFixed(4), q1024: +M.all(ref1024, a1024).msssimc.toFixed(4) });
  }
}
fs.appendFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(rows.map(r => `${r.image} ${r.variant} k=${r.k}: q512=${r.q512} q1024=${r.q1024}`).join('\n'));
