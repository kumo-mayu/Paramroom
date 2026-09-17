'use strict';
// Picture sheet for the "coarse image first" experiment (docs/research/08 §6): current method vs a low resolution grid,
// at a few packet counts.
//   node grid-sheets.js <outDir> <image> [grids] [packet counts]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const I = require('./lib/image');
const M = require('./lib/metrics');
const primx = require('./codecs/primx');

const P = 254, R = 512, CELL_BITS = 12, UNITS = 1000;
const [outDirArg, image, gridsArg, ksArg] = process.argv.slice(2);
const outDir = path.resolve(outDirArg);
const grids = (gridsArg || '0,16,24').split(',').map(Number);
const KS = (ksArg || '10,20,40,150').split(',').map(Number);
const cacheDir = path.join(__dirname, 'cache', 'grid');
const ref = I.loadPNG(path.join(__dirname, 'images', 'ref' + R, image + '.png'));
const cellsPerPacket = Math.floor((P - 10) / CELL_BITS);
const cfgBase = { shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2 };
const cfgFor = n => {
  const probe = { ...primx.cfgOf({ ...cfgBase, R, maxPrims: 4000 }), out: R };
  const L = primx.layout(probe, P);
  return { ...primx.cfgOf({ ...cfgBase, R, maxPrims: L.k0 + L.k * n }), out: R };
};
const gridOf = g => {
  const small = I.resize(ref, g, g), cells = new Float64Array(g * g * 3);
  for (let i = 0; i < g * g * 3; i++) cells[i] = Math.round(small.data[i] / 255 * 15) * 255 / 15;
  return { w: g, h: g, c: 3, data: cells };
};
const bg = (() => { const t = I.resize(ref, R, R).data, m = [0, 0, 0]; for (let i = 0; i < t.length; i++) m[i % 3] += t[i] / (R * R); return m.map(v => Math.round(v / 255 * 15) * 255 / 15); })();

fs.mkdirSync(outDir, { recursive: true });
const tmp = path.join(cacheDir, 'tiles');
fs.mkdirSync(tmp, { recursive: true });
const tiles = [];
for (const G of grids) {
  const c = JSON.parse(fs.readFileSync(path.join(cacheDir, `${image}-g${G}.json`), 'utf8'));
  const cfg = cfgFor(UNITS - c.gridPackets);
  const units = c.units.map(s => [...s].map(Number));
  const order = c.gains.map((g, i) => [i, g === null ? Infinity : g]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const grid = G === 0 ? null : gridOf(G);
  tiles.push({ img: ref, label: '元画像' });
  for (const k of KS) {
    const gp = Math.min(k, c.gridPackets);
    let base;
    if (grid) {
      const part = { w: G, h: G, c: 3, data: Float64Array.from(grid.data) };
      for (let i = Math.min(G * G, gp * cellsPerPacket); i < G * G; i++) for (let ch = 0; ch < 3; ch++) part.data[i * 3 + ch] = bg[ch];
      base = I.resize(part, R, R);
    }
    const dec = primx.decoder(cfg, P);
    for (const u of order.slice(0, Math.max(0, k - c.gridPackets))) dec.apply(units[u]);
    const img = dec.render(base);
    tiles.push({ img, label: `${G === 0 ? '現行' : G + 'x' + G + 'グリッド'} ${k}パケット（${(k / 10).toFixed(1)}秒） MS-SSIM ${M.all(ref, img).msssimc.toFixed(4)}` });
  }
}

const ffmpeg = require('../measure/analysis/node_modules/ffmpeg-static');
const font = 'C\\:/Windows/Fonts/YuGothB.ttc';
const files = tiles.map((t, i) => { const p = path.join(tmp, `g-${i}.png`); I.savePNG(I.resize(t.img, 420, 420), p); return p; });
const tw = 420, th = 420, band = 30, cols = KS.length + 1;
const esc = s => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
const args = ['-hide_banner', '-loglevel', 'error', '-y'];
files.forEach(f => args.push('-i', f));
const chains = files.map((f, i) => `[${i}:v]pad=${tw}:${th + band}:0:${band}:white,drawtext=fontfile='${font}':text='${esc(tiles[i].label)}':x=6:y=6:fontsize=14:fontcolor=black[t${i}]`);
const layout = files.map((_, i) => `${(i % cols) * tw}_${Math.floor(i / cols) * (th + band)}`).join('|');
const title = `${image}：最初に粗い画像を送る案の比較（512 キャンバス）`;
const filter = chains.join(';') + `;${files.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=white[g];` +
  `[g]pad=iw:ih+40:0:40:white,drawtext=fontfile='${font}':text='${esc(title)}':x=10:y=9:fontsize=20:fontcolor=black[out]`;
args.push('-filter_complex', filter, '-map', '[out]', '-frames:v', '1', path.join(outDir, `${image}-grid.png`));
const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
if (r.status !== 0) throw new Error(r.stderr);
console.log(`wrote ${path.join(outDir, image + '-grid.png')}`);
