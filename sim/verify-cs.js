'use strict';
// Verify units encoded by tools/ImagePadTool (C#) with the JS prim decoder.
// usage: node verify-cs.js <units.json> <source image> [--canvas cs-canvas.png] [--js js-render.png] [--fit stretch|crop]
//   - decodes the units with sim/codecs/prim.js and scores the render (MS-SSIM YCbCr 6:1:1, PSNR) against the target
//     (source stretched / cropped to R x R, as the encoders see it)
//   - --canvas: the C# encoder canvas must equal the JS render (max abs diff)
//   - --js: a JS encoder render of the same target, scored the same way for comparison
const fs = require('fs');
const I = require('./lib/image');
const M = require('./lib/metrics');
const prim = require('./codecs/prim');

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf('--' + n); return i < 0 ? null : argv[i + 1]; };
const j = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
let src = I.loadPNG(argv[1]);
if (opt('fit') === 'crop') { const s = Math.min(src.w, src.h); src = I.crop(src, (src.w - s) >> 1, (src.h - s) >> 1, s, s); }
const target = I.resize(src, j.R, j.R);
// layout of the decoder the units were made for: capacity (primitives) and packet size (Int parameters)
const P = 8 * (j.bytes || 32) - 2;
const cfg = { ...prim.cfgOf({ shape: 'ell', cb: j.cb ?? (j.R >= 1024 ? 10 : 9), rb: j.rb ?? 8, ab: j.ab ?? 6, col: j.col ?? [5, 6, 5], aBits: j.aBits ?? 2, R: j.R, maxPrims: j.capacity || j.n }), out: j.R };
const L = prim.layout(cfg, P);
if (j.units.length > L.units) throw new Error(`too many units ${j.units.length} > ${L.units}`);
const dec = prim.decoder(cfg, P);
for (const u of j.units) dec.apply([...u].map(Number));
const r = dec.render();
const m = M.all(target, r);
console.log(`C# units: ${j.units.length} (${j.bytes || 32} Int, capacity ${j.capacity || j.n}, layout u=${L.u} k=${L.k}, ${j.prims} prims, enc ${j.encSec.toFixed(2)} s) -> msssimc ${m.msssimc.toFixed(4)} psnr ${m.psnr.toFixed(2)} dB`);
if (opt('canvas')) {
  const c = I.loadPNG(opt('canvas'));
  let md = 0; for (let i = 0; i < c.data.length; i++) md = Math.max(md, Math.abs(c.data[i] - r.data[i]));
  console.log(`C# canvas vs JS render: max abs diff ${md}`);
}
if (opt('js')) {
  const js = I.loadPNG(opt('js'));
  const mj = M.all(target, js);
  console.log(`JS encoder render:            msssimc ${mj.msssimc.toFixed(4)} psnr ${mj.psnr.toFixed(2)} dB`);
}
