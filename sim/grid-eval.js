'use strict';
// Would a coarse image first help? (docs/research/07)
// Today the first thing a viewer sees is a handful of huge ellipses. The alternative tested here: spend the first few
// packets on a low resolution image (a G x G grid of RGB 4:4:4 cells, drawn by the shader as one bilinear texture
// lookup) and let the primitives refine that. A packet holds floor((254 - u) / 12) cells, so the grid itself is
// progressive: cells that have not arrived stay at the background colour.
//   node grid-eval.js encode <image> <grid>   -> cache/grid/<image>-g<grid>.json   (grid 0 = today, no grid)
//   node grid-eval.js eval   <image> <grid>   -> results/gridval.jsonl
//   node grid-eval.js summary                 -> results/gridval.md
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const M = require('./lib/metrics');
const primx = require('./codecs/primx');
const { padBits } = require('./lib/evaluate');

const P = 254;
const R = 512;
const UNITS = 1000;           // total packet budget, grid packets included
const CELL_BITS = 12;         // RGB 4:4:4 per cell
const KS = [5, 10, 20, 40, 80, 150, 300, 600, 1001]; // packets delivered (in gain order) to score at
const cacheDir = path.join(__dirname, 'cache', 'grid');
const outFile = path.join(__dirname, 'results', 'gridval.jsonl');
const [cmd, image, gs] = process.argv.slice(2);
const G = Number(gs || 0);

const refOf = img => I.loadPNG(path.join(__dirname, 'images', 'ref' + R, img + '.png'));
const cellsPerPacket = u => Math.floor((P - u) / CELL_BITS);

// the grid: cell = mean of its block, quantized to 4 bits per channel
function gridOf(ref, g) {
  const small = I.resize(ref, g, g);
  const cells = new Float64Array(g * g * 3);
  for (let i = 0; i < g * g * 3; i++) cells[i] = Math.round(small.data[i] / 255 * 15) * 255 / 15;
  return { w: g, h: g, c: 3, data: cells };
}
// what the shader would show: bilinear upscale of the cells that arrived, background elsewhere
function baseFrom(grid, nCells, bg) {
  const g = grid.w;
  const part = { w: g, h: g, c: 3, data: Float64Array.from(grid.data) };
  for (let i = nCells; i < g * g; i++) for (let ch = 0; ch < 3; ch++) part.data[i * 3 + ch] = bg[ch];
  return I.resize(part, R, R);
}
const meanColour = ref => {
  const t = I.resize(ref, R, R).data, m = [0, 0, 0];
  for (let i = 0; i < t.length; i++) m[i % 3] += t[i] / (R * R);
  return m.map(v => Math.round(v / 255 * 15) * 255 / 15);
};

const cfgBase = { shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2 };
function cfgFor(nPrimUnits) {
  const probe = { ...primx.cfgOf({ ...cfgBase, R, maxPrims: 4000 }), out: R };
  const L = primx.layout(probe, P);
  return { ...primx.cfgOf({ ...cfgBase, R, maxPrims: L.k0 + L.k * nPrimUnits }), out: R };
}
const cacheFile = (img = image, g = G) => path.join(cacheDir, `${img}-g${g}.json`);
const gridPackets = g => (g === 0 ? 0 : Math.ceil(g * g / cellsPerPacket(10)));

if (cmd === 'encode') {
  fs.mkdirSync(cacheDir, { recursive: true });
  const ref = refOf(image);
  const pg = gridPackets(G);
  const cfg = cfgFor(UNITS - pg);
  const base = G === 0 ? undefined : I.resize(gridOf(ref, G), R, R);
  const t0 = Date.now();
  const enc = primx.encode(ref, cfg, P, base);
  fs.writeFileSync(cacheFile(), JSON.stringify({
    image, G, gridPackets: pg, R, encSec: (Date.now() - t0) / 1000,
    units: enc.units.map(u => padBits(u, P).join('')), gains: enc.gains,
  }));
  console.log(`${image} g${G}: ${pg} grid packets + ${enc.units.length} prim units, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} else if (cmd === 'eval') {
  const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  const cfg = cfgFor(UNITS - c.gridPackets);
  const units = c.units.map(s => [...s].map(Number));
  const ref = refOf(image);
  const grid = G === 0 ? null : gridOf(ref, G);
  const bg = meanColour(ref);
  const order = c.gains.map((g, i) => [i, g === null ? Infinity : g]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const cpp = cellsPerPacket(10);
  const rows = [];
  for (const k of KS) {
    // packets are spent on the grid first (it is what makes the image recognisable), then on primitives in gain order
    const gp = Math.min(k, c.gridPackets);
    const base = grid ? baseFrom(grid, Math.min(G * G, gp * cpp), bg) : undefined;
    const dec = primx.decoder(cfg, P);
    for (const u of order.slice(0, Math.max(0, k - c.gridPackets))) dec.apply(units[u]);
    rows.push({ image, G, gridPackets: c.gridPackets, k, q: +M.all(ref, dec.render(base)).msssimc.toFixed(4) });
  }
  fs.appendFileSync(outFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(rows.map(r => `${r.image} g${r.G} k=${r.k}: ${r.q}`).join('\n'));
} else if (cmd === 'summary') {
  const rows = fs.readFileSync(outFile, 'utf8').trim().split('\n').map(JSON.parse);
  const images = [...new Set(rows.map(r => r.image))];
  const gs = [...new Set(rows.map(r => r.G))].sort((a, b) => a - b);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const lines = ['# 最初に粗い画像を送る案（低解像度グリッド + 図形）', '',
    `画像 ${images.length} 枚、キャンバス ${R}、パケット合計 ${UNITS + 1} 個。1 パケット 100 ms なので k パケット ≒ k/10 秒。`,
    'グリッドは 1 セル RGB 4:4:4、届いた分だけ表示（残りは背景色）。図形は誤差削減の大きい順。MS-SSIM (YCbCr 6:1:1)。', '',
    '| グリッド | グリッドに使うパケット | ' + KS.map(k => `k=${k}`).join(' | ') + ' |',
    '|---|---:|' + KS.map(() => '---:').join('|') + '|'];
  for (const g of gs) {
    const sub = rows.filter(r => r.G === g);
    lines.push(`| ${g === 0 ? '無し（現行）' : `${g}x${g}`} | ${sub[0].gridPackets} | ` +
      KS.map(k => { const v = sub.filter(r => r.k === k); return v.length ? mean(v.map(r => r.q)).toFixed(4) : '-'; }).join(' | ') + ' |');
  }
  const out = path.join(__dirname, 'results', 'gridval.md');
  fs.writeFileSync(out, lines.join('\n'));
  console.log(lines.join('\n'));
} else {
  console.log('usage: node grid-eval.js encode|eval|summary <image> <grid>');
}
