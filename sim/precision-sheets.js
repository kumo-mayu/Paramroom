'use strict';
// Picture sheets for the reduced-precision variants (after precision-eval.js):
//   <image>-full.png : original + every variant with all units received, 1:1 crop of the 512 canvas
//   <image>-time.png : viewer present from the start (fast+sqrt/8), whole canvas at 10 / 20 / 60 s per variant
// usage: node precision-sheets.js <outDir>
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const I = require('./lib/image');

const outDir = path.resolve(process.argv[2]);
const cacheDir = path.join(__dirname, 'cache', 'precision');
const resultsDir = path.join(__dirname, 'results', 'precision');
const ffmpeg = require('../measure/analysis/node_modules/ffmpeg-static');
const font = 'C\\:/Windows/Fonts/YuGothB.ttc';
const esc = s => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
const IMAGES = { screenshot_mahara: [0, 20, 300, 300], kodim23: [40, 100, 300, 300], illust_chibi: [140, 60, 300, 300] };
const tmp = path.join(__dirname, 'cache', 'precision-tiles');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(tmp, { recursive: true });

function sheet(tiles, cols, title, file) {
  const tw = tiles[0].img.w, th = tiles[0].img.h, band = 36;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  tiles.forEach((t, i) => { const p = path.join(tmp, `t${i}.png`); I.savePNG(t.img, p); args.push('-i', p); });
  const chains = tiles.map((t, i) => `[${i}:v]pad=${tw}:${th + band}:0:${band}:white,drawtext=fontfile='${font}':text='${esc(t.label)}':x=6:y=4:fontsize=13:fontcolor=black,drawtext=fontfile='${font}':text='${esc(t.sub || '')}':x=6:y=20:fontsize=12:fontcolor=0x57606A[t${i}]`);
  const layout = tiles.map((_, i) => `${(i % cols) * tw}_${Math.floor(i / cols) * (th + band)}`).join('|');
  const filter = chains.join(';') + `;${tiles.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${tiles.length}:layout=${layout}:fill=white[g];` +
    `[g]pad=iw:ih+44:0:44:white,drawtext=fontfile='${font}':text='${esc(title)}':x=10:y=10:fontsize=20:fontcolor=black[out]`;
  args.push('-filter_complex', filter, '-map', '[out]', '-frames:v', '1', file);
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  console.log('wrote ' + path.basename(file));
}

const describe = r => `${r.variant} ${r.label.replace(/-r512-n\d+/, '')}（${r.primBits} bit）`;
for (const [image, [cx, cy, cw, ch]] of Object.entries(IMAGES)) {
  const rows = fs.readdirSync(resultsDir).filter(f => f.startsWith(image + '-')).map(f => JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8')))
    .sort((a, b) => a.variant.localeCompare(b.variant) || a.n - b.n);
  const ref = I.loadPNG(path.join(__dirname, 'images', 'ref512', image + '.png'));
  const full = [{ img: I.crop(ref, cx, cy, cw, ch), label: '元画像', sub: '512 に縮小したもの' }];
  for (const r of rows) {
    const img = I.loadPNG(path.join(cacheDir, `${image}-${r.variant}-n${r.n}.png`));
    full.push({ img: I.crop(img, cx, cy, cw, ch), label: describe(r), sub: `図形${r.n}・${r.k}個/pkt・${r.units}pkt（${Math.round(r.lapSec)}秒）・${r.full.toFixed(3)}` });
  }
  sheet(full, 4, `${image}：全部届いたとき（512 キャンバスの一部を等倍で切り出し）`, path.join(outDir, `${image}-full.png`));

  const time = [];
  for (const r of rows) for (const t of [10, 20, 60]) {
    const img = I.resize(I.loadPNG(path.join(cacheDir, `${image}-${r.variant}-n${r.n}-t${t}.png`)), 256, 256);
    time.push({ img, label: t === 10 ? describe(r) : `${t} 秒`, sub: t === 10 ? `図形 ${r.n}・${r.units} パケット・10 秒` : '' });
  }
  sheet(time, 3, `${image}：開始時から見ている人（fast+sqrt/8）、左から 10 / 20 / 60 秒`, path.join(outDir, `${image}-time.png`));
}
