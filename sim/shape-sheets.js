'use strict';
// Picture sheets for the representation experiments (docs/research/08): one row per representation, one column per
// "how much has arrived", so the numbers in results/shapeeval.md can be checked by eye.
//   node shape-sheets.js <outDir> <image> [variant,variant,...] [frac,frac,...]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const I = require('./lib/image');
const M = require('./lib/metrics');
const primx = require('./codecs/primx');

const P = 254, R = 512;
const [outDirArg, image, varsArg, fracsArg] = process.argv.slice(2);
const outDir = path.resolve(outDirArg);
const variants = (varsArg || 'base,light,deep,softbase,circ39,addhard').split(',');
const fracs = (fracsArg || '0.05,0.15,1').split(',').map(Number);
const cacheDir = path.join(__dirname, 'cache', 'shape');
const evalRows = fs.existsSync(path.join(__dirname, 'results', 'shapeeval.jsonl'))
  ? fs.readFileSync(path.join(__dirname, 'results', 'shapeeval.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];

// the same configs as shape-eval.js (kept in one place there)
const SHAPE = require('./lib/shape-variants');
const ref = I.loadPNG(path.join(__dirname, 'images', 'ref' + R, image + '.png'));

fs.mkdirSync(outDir, { recursive: true });
const tmp = path.join(cacheDir, 'tiles');
fs.mkdirSync(tmp, { recursive: true });
const tiles = [];
for (const v of variants) {
  tiles.push({ img: ref, label: '元画像' });
  const c = JSON.parse(fs.readFileSync(path.join(cacheDir, `${image}-${v}.json`), 'utf8'));
  const cfg = SHAPE.cfgFor(v, R, P);
  const units = c.units.map(s => [...s].map(Number));
  const order = c.gains.map((g, i) => [i, g === null ? Infinity : g]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  for (const f of fracs) {
    const k = Math.max(1, Math.round(units.length * f));
    const dec = primx.decoder(cfg, P);
    for (const u of order.slice(0, k)) dec.apply(units[u]);
    const img = dec.render();
    const row = evalRows.find(r => r.image === image && r.variant === v && r.frac === f);
    const q = row ? row.q : M.all(ref, img).msssimc;
    tiles.push({ img, label: `${v}（${c.primBits}bit×${c.maxPrims}） ${k}パケット MS-SSIM ${q.toFixed(4)}` });
  }
}

const ffmpeg = require('../measure/analysis/node_modules/ffmpeg-static');
const font = 'C\\:/Windows/Fonts/YuGothB.ttc';
const files = tiles.map((t, i) => { const p = path.join(tmp, `s-${i}.png`); I.savePNG(I.resize(t.img, 420, 420), p); return p; });
const tw = 420, th = 420, band = 30, cols = fracs.length + 1;
const esc = s => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
const args = ['-hide_banner', '-loglevel', 'error', '-y'];
files.forEach(f => args.push('-i', f));
const chains = files.map((f, i) => `[${i}:v]pad=${tw}:${th + band}:0:${band}:white,drawtext=fontfile='${font}':text='${esc(tiles[i].label)}':x=6:y=6:fontsize=14:fontcolor=black[t${i}]`);
const layout = files.map((_, i) => `${(i % cols) * tw}_${Math.floor(i / cols) * (th + band)}`).join('|');
const title = `${image}：表現の比較（512 キャンバス・パケット 1001 個・到着パケット数ごと）`;
const filter = chains.join(';') + `;${files.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=white[g];` +
  `[g]pad=iw:ih+40:0:40:white,drawtext=fontfile='${font}':text='${esc(title)}':x=10:y=9:fontsize=20:fontcolor=black[out]`;
args.push('-filter_complex', filter, '-map', '[out]', '-frames:v', '1', path.join(outDir, `${image}-variants.png`));
const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
if (r.status !== 0) throw new Error(r.stderr);
console.log(`wrote ${path.join(outDir, image + '-variants.png')}`);
