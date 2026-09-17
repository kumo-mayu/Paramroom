'use strict';
// Visual comparison sheets of the prim codec over canvas size (256/512/1024) and primitive count (1000/2000/4000).
//   node make-comparison.js encode <image> <R> <n>   -> cache/compare/<image>-r<R>-n<n>.png (render at R, true aspect not applied)
//   node make-comparison.js sheets <outDir> [R/n,R/n,...] -> <outDir>/<image>-overview.png, <image>-zoom.png (default: all configs)
// Images: screenshot_mahara (whole page 960x847, stretched to the square canvas as sent in VRChat),
//         illust_chibi (top 960x960 square), kodim23 (centre 512x512 square; 1024 is upsampled from 512).
// Coordinates: 9 bit up to R=512, 10 bit at R=1024 (2 px steps otherwise).
// Sheets: every render is resized to a common display of long side 1024 at the true aspect ratio; overview tiles are
// downscaled to long side 480, zoom tiles are 1:1 crops of the 1024 display.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const I = require('./lib/image');
const prim = require('./codecs/prim');
const { padBits } = require('./lib/evaluate');

const IMAGES = {
  screenshot_mahara: { load: src => src, zoom: [0, 60, 520, 390], label: 'Mahara スクリーンショット（ページ全体）' },
  illust_chibi: { load: src => I.crop(src, 0, 0, src.w, src.w), zoom: [300, 260, 520, 390], label: 'イラスト（960px 正方形）' },
  kodim23: { load: src => { const s = Math.min(src.w, src.h); return I.crop(src, (src.w - s) >> 1, (src.h - s) >> 1, s, s); }, zoom: [80, 200, 520, 390], label: '写真 kodim23（元は 512px 正方形）' },
};
const CONFIGS = [[256, 1000], [256, 2000], [256, 4000], [512, 1000], [512, 2000], [512, 4000], [1024, 1000], [1024, 2000], [1024, 4000]];
const cacheDir = path.join(__dirname, 'cache', 'compare');
const cfgFor = (R, n) => ({ ...prim.cfgOf({ shape: 'ell', cb: R >= 1024 ? 10 : 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, R, maxPrims: n }), out: R });
const srcOf = image => IMAGES[image].load(I.loadPNG(path.join(__dirname, 'images', 'src', image + '.png')));
const displaySize = img => img.w >= img.h ? [1024, Math.round(1024 * img.h / img.w)] : [Math.round(1024 * img.w / img.h), 1024];

const [cmd, a1, a2, a3] = process.argv.slice(2);
if (cmd === 'encode') {
  const image = a1, R = Number(a2), n = Number(a3);
  fs.mkdirSync(cacheDir, { recursive: true });
  const cfg = cfgFor(R, n);
  const t0 = Date.now();
  const enc = prim.encode(I.resize(srcOf(image), R, R), cfg, 254);
  const dec = prim.decoder(cfg, 254);
  enc.units.forEach(u => dec.apply(padBits(u, 254)));
  I.savePNG(dec.render(), path.join(cacheDir, `${image}-r${R}-n${n}.png`));
  fs.writeFileSync(path.join(cacheDir, `${image}-r${R}-n${n}.txt`), `${enc.units.length} ${(Date.now() - t0) / 1000}`);
  console.log(`${image} R${R} n${n}: ${enc.units.length} units, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} else if (cmd === 'sheets') {
  const outDir = path.resolve(a1);
  const configs = a2 ? a2.split(',').map(c => c.split('/').map(Number)) : CONFIGS;
  fs.mkdirSync(outDir, { recursive: true });
  const ffmpeg = require('../measure/analysis/node_modules/ffmpeg-static'); // installed with the measurement tools
  const tmp = path.join(cacheDir, 'tiles');
  fs.mkdirSync(tmp, { recursive: true });
  const font = 'C\\:/Windows/Fonts/YuGothB.ttc';
  for (const [image, spec] of Object.entries(IMAGES)) {
    const src = srcOf(image);
    const [W, H] = displaySize(src);
    const tiles = [{ img: I.resize(src, W, H), label: '元画像' }];
    for (const [R, n] of configs) {
      const f = path.join(cacheDir, `${image}-r${R}-n${n}.png`);
      const [units] = fs.readFileSync(f.replace(/\.png$/, '.txt'), 'utf8').split(' ');
      const now = R === 256 && n === 1000 ? '・最初の実機版' : '';
      tiles.push({ img: I.resize(I.loadPNG(f), W, H), label: `${R}px・図形${n}（${units}ユニット${now}）` });
    }
    for (const kind of ['overview', 'zoom']) {
      const files = tiles.map((t, i) => {
        let img;
        if (kind === 'overview') { const s = 480 / 1024; img = I.resize(t.img, Math.round(W * s), Math.round(H * s)); }
        else { const [x, y, w, h] = spec.zoom; img = I.crop(t.img, x, y, Math.min(w, W - x), Math.min(h, H - y)); }
        const p = path.join(tmp, `${image}-${kind}-${i}.png`);
        I.savePNG(img, p);
        return { p, w: img.w, h: img.h };
      });
      const tw = files[0].w, th = files[0].h, band = 34, cols = 5;
      const args = ['-hide_banner', '-loglevel', 'error', '-y'];
      files.forEach(f => args.push('-i', f.p));
      const esc = s => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
      const chains = files.map((f, i) => `[${i}:v]pad=${tw}:${th + band}:0:${band}:white,drawtext=fontfile='${font}':text='${esc(tiles[i].label)}':x=8:y=7:fontsize=${kind === 'overview' ? 15 : 17}:fontcolor=black[t${i}]`);
      const layout = files.map((_, i) => `${(i % cols) * tw}_${Math.floor(i / cols) * (th + band)}`).join('|');
      const title = kind === 'overview' ? `${spec.label}：全体（表示は長辺 480px に縮小）` : `${spec.label}：拡大（長辺 1024px 表示の一部を等倍で切り出し）`;
      const filter = chains.join(';') + `;${files.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=white[g];` +
        `[g]pad=iw:ih+44:0:44:white,drawtext=fontfile='${font}':text='${esc(title)}':x=10:y=10:fontsize=22:fontcolor=black[out]`;
      args.push('-filter_complex', filter, '-map', '[out]', '-frames:v', '1', path.join(outDir, `${image}-${kind}.png`));
      const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      console.log(`wrote ${image}-${kind}.png`);
    }
  }
}
