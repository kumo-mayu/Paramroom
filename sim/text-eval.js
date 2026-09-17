'use strict';
// Legibility check for the stroke experiment (docs/research/08 §14). MS-SSIM over a whole page says little about
// whether the text can be read, so this scores only a text-heavy crop of the page and writes a 1:1 sheet of that crop
// so it can be judged by eye.
//   node text-eval.js <outDir> <image> [variants] [packet counts]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const I = require('./lib/image');
const M = require('./lib/metrics');
const primx = require('./codecs/primx');
const SHAPE = require('./lib/shape-variants');

const P = 254, R = 512;
// text-heavy crops of the 512 references (x, y, w, h), picked by looking at the reference
const CROPS = {
  screenshot_wikipedia: [118, 215, 352, 208],
  screenshot_mahara: [40, 150, 460, 230],
};
const [outDirArg, image, varsArg, ksArg] = process.argv.slice(2);
const outDir = path.resolve(outDirArg);
const variants = (varsArg || 'base,cap,mix,capdeep,mixdeep').split(',');
const KS = (ksArg || '150,400,1001').split(',').map(Number);
const cacheDir = path.join(__dirname, 'cache', 'shape');
const ref = I.loadPNG(path.join(__dirname, 'images', 'ref' + R, image + '.png'));
const crop = CROPS[image];
if (!crop) throw new Error('no text crop defined for ' + image);
const refCrop = I.crop(ref, ...crop);

fs.mkdirSync(outDir, { recursive: true });
const tmp = path.join(cacheDir, 'tiles');
fs.mkdirSync(tmp, { recursive: true });
const tiles = [];
const rows = [];
for (const v of variants) {
  const c = JSON.parse(fs.readFileSync(path.join(cacheDir, `${image}-${v}.json`), 'utf8'));
  const cfg = SHAPE.cfgFor(v, R, P);
  const units = c.units.map(s => [...s].map(Number));
  const order = c.gains.map((g, i) => [i, g === null ? Infinity : g]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  tiles.push({ img: refCrop, label: '元画像' });
  for (const k of KS) {
    const dec = primx.decoder(cfg, P);
    for (const u of order.slice(0, Math.min(k, units.length))) dec.apply(units[u]);
    const img = I.crop(dec.render(), ...crop);
    const q = M.all(refCrop, img).msssimc;
    rows.push({ image, variant: v, k, q: +q.toFixed(4) });
    tiles.push({ img, label: `${v} ${k}パケット（${(k / 10).toFixed(0)}秒） 文字部分 MS-SSIM ${q.toFixed(4)}` });
  }
}
console.log(rows.map(r => `${r.image} ${r.variant} k=${r.k}: ${r.q}`).join('\n'));
fs.appendFileSync(path.join(__dirname, 'results', 'textcrop.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

const ffmpeg = require('../measure/analysis/node_modules/ffmpeg-static');
const font = 'C\\:/Windows/Fonts/YuGothB.ttc';
const files = tiles.map((t, i) => { const p = path.join(tmp, `t-${i}.png`); I.savePNG(t.img, p); return p; });
const tw = crop[2], th = crop[3], band = 26, cols = KS.length + 1;
const esc = s => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
const args = ['-hide_banner', '-loglevel', 'error', '-y'];
files.forEach(f => args.push('-i', f));
const chains = files.map((f, i) => `[${i}:v]pad=${tw}:${th + band}:0:${band}:white,drawtext=fontfile='${font}':text='${esc(tiles[i].label)}':x=6:y=5:fontsize=13:fontcolor=black[t${i}]`);
const layout = files.map((_, i) => `${(i % cols) * tw}_${Math.floor(i / cols) * (th + band)}`).join('|');
const title = `${image}：文字部分を等倍で比較（512 キャンバス・パケット 1001 個）`;
const filter = chains.join(';') + `;${files.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=white[g];` +
  `[g]pad=iw:ih+38:0:38:white,drawtext=fontfile='${font}':text='${esc(title)}':x=10:y=8:fontsize=19:fontcolor=black[out]`;
args.push('-filter_complex', filter, '-map', '[out]', '-frames:v', '1', path.join(outDir, `${image}-text.png`));
const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
if (r.status !== 0) throw new Error(r.stderr);
console.log(`wrote ${path.join(outDir, image + '-text.png')}`);
