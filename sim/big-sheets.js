'use strict';
// 1:1 crop of the text area, 512 canvas vs 1024 canvas (docs/research/08 §17). Both are shown at 1024 display size
// (the 512 renders upscaled), which is what a viewer walking up to the picture sees.
//   node big-sheets.js <outDir> <image> [variants] [packets]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const I = require('./lib/image');
const M = require('./lib/metrics');
const primx = require('./codecs/primx');
const SHAPE = require('./lib/shape-variants');

const P = 254;
// text-heavy crops in 1024 coordinates (twice the 512 crops used by text-eval.js)
const CROPS = {
  screenshot_wikipedia: [236, 430, 704, 416],
  screenshot_mahara: [80, 300, 800, 400],
  // whole-page versions (what the sender actually sends for a screenshot): the text is 2x smaller on the canvas
  screenshot_mahara_full: [40, 120, 900, 420],
  screenshot_wikipedia_full: [40, 180, 900, 420],
};
const [outDirArg, image, varsArg, ksArg] = process.argv.slice(2);
const outDir = path.resolve(outDirArg);
const variants = (varsArg || 'base,capdeeprfx,big,bigcapdeeprf').split(',');
const KS = (ksArg || '400,1001').split(',').map(Number);
const cacheDir = path.join(__dirname, 'cache', 'shape');
const crop = CROPS[image];
if (!crop) throw new Error('no crop for ' + image);
const ref = I.loadPNG(path.join(__dirname, 'images', 'ref1024', image + '.png'));
const refCrop = I.crop(ref, ...crop);

fs.mkdirSync(outDir, { recursive: true });
const tmp = path.join(cacheDir, 'tiles');
fs.mkdirSync(tmp, { recursive: true });
const tiles = [];
for (const v of variants) {
  const R = SHAPE.VARIANTS[v].cb >= 10 ? 1024 : 512;
  const c = JSON.parse(fs.readFileSync(path.join(cacheDir, `${image}-${v}${R === 512 ? '' : '-r' + R}.json`), 'utf8'));
  const cfg = SHAPE.cfgFor(v, R, P);
  const units = c.units.map(s => [...s].map(Number));
  const order = c.gains.map((g, i) => [i, g === null ? Infinity : g]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  tiles.push({ img: refCrop, label: '元画像（1024）' });
  for (const k of KS) {
    const dec = primx.decoder(cfg, P);
    for (const u of order.slice(0, Math.min(k, units.length))) dec.apply(units[u]);
    const full = R === 1024 ? dec.render() : I.resize(dec.render(), 1024, 1024);
    const img = I.crop(full, ...crop);
    tiles.push({ img, label: `${v}（${R}） ${k}パケット（${(k / 10).toFixed(0)}秒） MS-SSIM ${M.all(refCrop, img).msssimc.toFixed(4)}` });
  }
}

const ffmpeg = require('../measure/analysis/node_modules/ffmpeg-static');
const font = 'C\\:/Windows/Fonts/YuGothB.ttc';
const files = tiles.map((t, i) => { const p = path.join(tmp, `b-${i}.png`); I.savePNG(t.img, p); return p; });
const tw = crop[2], th = crop[3], band = 26, cols = KS.length + 1;
const esc = s => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
const args = ['-hide_banner', '-loglevel', 'error', '-y'];
files.forEach(f => args.push('-i', f));
const chains = files.map((f, i) => `[${i}:v]pad=${tw}:${th + band}:0:${band}:white,drawtext=fontfile='${font}':text='${esc(tiles[i].label)}':x=6:y=5:fontsize=14:fontcolor=black[t${i}]`);
const layout = files.map((_, i) => `${(i % cols) * tw}_${Math.floor(i / cols) * (th + band)}`).join('|');
const title = `${image}：512 と 1024 の文字部分（1024 表示で等倍、パケット数は同じ 1001 個）`;
const filter = chains.join(';') + `;${files.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=white[g];` +
  `[g]pad=iw:ih+38:0:38:white,drawtext=fontfile='${font}':text='${esc(title)}':x=10:y=8:fontsize=19:fontcolor=black[out]`;
args.push('-filter_complex', filter, '-map', '[out]', '-frames:v', '1', path.join(outDir, `${image}-1024.png`));
const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
if (r.status !== 0) throw new Error(r.stderr);
console.log(`wrote ${path.join(outDir, image + '-1024.png')}`);
