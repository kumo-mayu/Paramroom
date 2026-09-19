'use strict';
// Compare a VRChat photo taken with the local image camera jack against the images it should show (docs/research/13).
//   node jack-compare.js <photo.png> <reference.png> [<original.png>] [--out <prefix>]
// Finds the image inside the black letterbox, averages it down to the reference's size (box filter), and reports
// the per-channel mean difference (colour shift), PSNR and MS-SSIM against the reference decode (and the original).
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const I = require(path.join(__dirname, '..', '..', 'sim', 'lib', 'image.js'));
const M = require(path.join(__dirname, '..', '..', 'sim', 'lib', 'metrics.js'));

const argv = process.argv.slice(2);
const files = argv.filter(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--out');
const outPrefix = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
const [photoFile, refFile, origFile] = files;
const ref = I.loadPNG(refFile);
const png = PNG.sync.read(fs.readFileSync(photoFile));
const { width: PW, height: PH, data } = png;
const px = (x, y, c) => data[(y * PW + x) * 4 + c];

// the image rectangle: where the photo stops being black, searched along the middle row / column
const lum = (x, y) => px(x, y, 0) + px(x, y, 1) + px(x, y, 2);
const expected = (() => { const s = Math.min(PW / ref.w, PH / ref.h); return { s, x0: (PW - ref.w * s) / 2, y0: (PH - ref.h * s) / 2 }; })();
let x0 = 0; while (x0 < PW && lum(x0, PH >> 1) < 12) x0++;
let x1 = PW - 1; while (x1 > 0 && lum(x1, PH >> 1) < 12) x1--;
let y0 = 0; while (y0 < PH && lum(PW >> 1, y0) < 12) y0++;
let y1 = PH - 1; while (y1 > 0 && lum(PW >> 1, y1) < 12) y1--;
// the edges of the picture may be dark themselves: trust the letterbox geometry the jack shader uses
const rect = { x0: expected.x0, y0: expected.y0, w: ref.w * expected.s, h: ref.h * expected.s };

// box-filter the photo's rectangle down to the reference size
const got = I.create(ref.w, ref.h, 3);
for (let y = 0; y < ref.h; y++)
  for (let x = 0; x < ref.w; x++) {
    const sx0 = rect.x0 + x * expected.s, sy0 = rect.y0 + y * expected.s;
    const ax = Math.floor(sx0), bx = Math.max(ax + 1, Math.floor(sx0 + expected.s)), ay = Math.floor(sy0), by = Math.max(ay + 1, Math.floor(sy0 + expected.s));
    for (let c = 0; c < 3; c++) {
      let s = 0, n = 0;
      for (let yy = ay; yy < by; yy++) for (let xx = ax; xx < bx; xx++) { s += px(Math.min(PW - 1, xx), Math.min(PH - 1, yy), c); n++; }
      got.data[(y * ref.w + x) * 3 + c] = s / n;
    }
  }
const mean = (img, c) => { let s = 0; for (let i = 0; i < img.w * img.h; i++) s += img.data[i * 3 + c]; return s / (img.w * img.h); };
const report = (name, target) => {
  const m = M.all(target, I.quantize8(got));
  return { against: name, meanShiftRGB: [0, 1, 2].map(c => +(mean(got, c) - mean(target, c)).toFixed(2)), psnr: +m.psnr.toFixed(2), msssimc: +m.msssimc.toFixed(4) };
};
const out = {
  photo: `${PW}x${PH}`, scale: +expected.s.toFixed(4),
  foundRect: { x0, x1, y0, y1 }, expectedRect: { x0: +expected.x0.toFixed(1), y0: +expected.y0.toFixed(1), w: +rect.w.toFixed(1), h: +rect.h.toFixed(1) },
  results: [report('reference decode', ref)].concat(origFile ? [report('original', I.loadPNG(origFile))] : []),
};
if (outPrefix) I.savePNG(I.quantize8(got), outPrefix + '-photo-scaled.png');
console.log(JSON.stringify(out, null, 1));
