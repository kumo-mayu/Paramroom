'use strict';
// Non-square images with the prim codec: stretch to the R x R canvas (display un-stretches) vs letterbox
// (fit into the canvas, pad with the mean colour, display crops). Quality is measured in display space
// (short side 256, true aspect) against the source, for prefixes of the unit sequence in send order (gains).
// usage: node aspect-test.js [out=results/aspect.md]
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const M = require('./lib/metrics');
const prim = require('./codecs/prim');
const { padBits } = require('./lib/evaluate');

const out = process.argv[2] || path.join(__dirname, 'results', 'aspect.md');
const cfg = prim.configs(256).find(c => c.label === 'e9.8.6-c565a2-r256-n1000');
const P = 254;
const PREFIX = [7, 13, 31, 57, 107, 251];
const srcDir = path.join(__dirname, 'images', 'src');

function displaySize(w, h) { return w < h ? [256, Math.round(256 * h / w)] : [Math.round(256 * w / h), 256]; }

function run(src, mode) {
  const [W, H] = displaySize(src.w, src.h);
  const target = I.resize(src, W, H);
  let canvas, box; // box = region of the 256 canvas holding the image
  if (mode === 'stretch') { canvas = I.resize(src, 256, 256); box = [0, 0, 256, 256]; }
  else {
    const s = 256 / Math.max(src.w, src.h), w = Math.round(src.w * s), h = Math.round(src.h * s);
    const fit = I.resize(src, w, h), mean = [0, 0, 0];
    for (let i = 0; i < fit.data.length; i++) mean[i % 3] += fit.data[i] / (w * h);
    canvas = I.create(256, 256, 3); for (let i = 0; i < 256 * 256 * 3; i++) canvas.data[i] = mean[i % 3];
    const x0 = (256 - w) >> 1, y0 = (256 - h) >> 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) canvas.data[((y0 + y) * 256 + x0 + x) * 3 + k] = fit.data[(y * w + x) * 3 + k];
    box = [x0, y0, w, h];
  }
  const enc = prim.encode(canvas, cfg, P);
  const order = enc.units.map((_, i) => i).sort((a, b) => (enc.gains[b] - enc.gains[a]) || (a - b));
  const dec = prim.decoder(cfg, P);
  const res = [];
  let n = 0;
  for (const p of PREFIX) {
    while (n < Math.min(p, order.length)) dec.apply(padBits(enc.units[order[n++]], P));
    const r = dec.render();
    const shown = I.resize(I.crop(r, box[0], box[1], box[2], box[3]), W, H);
    res.push(M.all(target, shown).msssimc);
  }
  return res;
}

const rows = [];
const acc = { stretch: PREFIX.map(() => 0), letterbox: PREFIX.map(() => 0) };
let count = 0;
for (const f of fs.readdirSync(srcDir).filter(f => f.endsWith('.png'))) {
  const src = I.loadPNG(path.join(srcDir, f));
  if (Math.abs(src.w / src.h - 1) < 0.02) continue;
  const s = run(src, 'stretch'), l = run(src, 'letterbox');
  s.forEach((v, i) => { acc.stretch[i] += v; acc.letterbox[i] += l[i]; });
  count++;
  rows.push(`| ${f} | ${(src.w / src.h).toFixed(2)} | ${s.map(v => v.toFixed(3)).join(' / ')} | ${l.map(v => v.toFixed(3)).join(' / ')} |`);
  console.log(rows[rows.length - 1]);
}
const avg = k => acc[k].map(v => (v / count).toFixed(3)).join(' / ');
const md = [
  '# prim の非正方形画像：引き伸ばし vs レターボックス',
  '',
  `設定 ${cfg.label}、送信順は gains 降順（平方根則の初期の近似）、表示空間（短辺 256、元の縦横比）で MS-SSIM (YCbCr 6:1:1)。`,
  `受信ユニット数 ${PREFIX.join(' / ')}（開始から約 1 / 2 / 5 / 10 / 20 / 60 秒に相当）。`,
  '',
  '| 画像 | 縦横比 | 引き伸ばし | レターボックス |',
  '|---|---|---|---|',
  ...rows,
  `| **平均（${count} 枚）** | | **${avg('stretch')}** | **${avg('letterbox')}** |`,
  '',
].join('\n');
fs.writeFileSync(out, md);
console.log(`average stretch ${avg('stretch')}\naverage letterbox ${avg('letterbox')}`);
