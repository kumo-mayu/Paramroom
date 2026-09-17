const path = require('path');
const I = require('../lib/image'); const M = require('../lib/metrics'); const T = require('../lib/transport');
const { loadCodec, padBits } = require('../lib/evaluate');
const imgs = require('fs').readdirSync(path.join(__dirname, '..', 'images', 'ref')).map(f => f.replace('.png', ''));
// 1. empty-state metrics as hard-coded in evaluate.js:64 vs real grey
let s = '';
for (const im of imgs.slice(0, 13)) { const ref = I.loadPNG(path.join(__dirname, '..', 'images', 'ref', im + '.png')); const g = I.create(256, 256, 3, 128); s += `${im}: ssim=${M.ssim(ref, g).toFixed(3)} ms=${M.msssim(ref, g).toFixed(3)}; `; }
console.log('grey image metrics (evaluate.js hard-codes 0):', s);
// 2. chroma blindness: swap Cb/Cr sign on a reference -> SSIM/MS-SSIM unchanged, PSNR falls
{ const ref = I.loadPNG(path.join(__dirname, '..', 'images', 'ref', 'kodim23.png'));
  const [Y, Cb, Cr] = I.rgbToYcc(ref); const g = { ...Cb, data: Cb.data.map(() => 128) }; const gr = { ...Cr, data: Cr.data.map(() => 128) };
  const out = I.quantize8(I.clamp255(I.yccToRgb(Y, g, gr)));
  console.log('kodim23 with chroma removed (greyscale): ', JSON.stringify(Object.fromEntries(Object.entries(M.all(ref, out)).map(([k, v]) => [k, +v.toFixed(3)])))); }
// 3. dctf clipping and zero-width groups on test images
const D = require('../codecs/dctf'); const C = require('../codecs/dct-common');
for (const B of [256, 64]) for (const label of ['r256-s1', 'r256-s2', 'r256-s4']) {
  const cfg = D.configs(B).find(c => c.label === label); if (!cfg) continue;
  const dec0 = D.decoder(cfg, B - 2); // builds packing
  for (const im of ['kodim23', 'illust_tux', 'screenshot_wikipedia']) {
    const ref = I.loadPNG(path.join(__dirname, '..', 'images', 'ref', im + '.png'));
    const enc = D.encode(ref, cfg, B - 2); const dec = D.decoder(cfg, B - 2); enc.units.forEach(u => dec.apply(padBits(u, B - 2)));
    // compare with unclipped dct reconstruction
    const lay = C.makeLayout(cfg); const q = C.quantizeImage(ref, lay);
    const ideal = C.reconstruct(q, lay);
    console.log(`dctf B=${B} ${label} ${im}: full psnr=${M.psnr(ref, dec.render()).toFixed(2)} vs unclipped-same-quantizer psnr=${M.psnr(ref, ideal).toFixed(2)}`);
  }
}
