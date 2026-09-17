'use strict';
// Export wire packets (32 bytes each, epoch 1) and the JS reference render of the prim codec for the Unity shader test.
// usage: node export-prim-test.js [image=kodim23] [out=../measure/unity/Assets/ImagePadMeasure/TestData] [--stretch] [--R 512 --n 4000] [--bytes 32]
//   default: images/ref/<image>.png (256x256, aspect byte 0 = 1:1, as before)
//   --stretch: images/src/<image>.png stretched to 256x256, aspect code (prim.aspectCode) in the last byte; the file
//              name gets a "-stretch" suffix and the JSON an "aspect" field.
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const prim = require('./codecs/prim');
const { padBits } = require('./lib/evaluate');

const opt = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : Number(process.argv[i + 1]); };
const R = opt('R', 256), nPrims = opt('n', 1000);
const argv = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && /^--(R|n|bytes)$/.test(all[i - 1])));
const stretch = process.argv.includes('--stretch');
const image = argv[0] || 'kodim23';
const outDir = argv[1] || path.join(__dirname, '..', 'measure', 'unity', 'Assets', 'ImagePadMeasure', 'TestData');
fs.mkdirSync(outDir, { recursive: true });
const NB = opt('bytes', 32), B = 8 * NB, P = B - 2; // --bytes: number of synced Int parameters
// R = canvas texels / coordinate range (256 or 512); the decoder renders at R (cfg.out)
const cfg = { ...prim.cfgOf({ shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, R, maxPrims: nPrims }), out: R };
let ref = I.loadPNG(path.join(__dirname, 'images', stretch ? 'src' : R === 256 ? 'ref' : 'ref' + R, image + '.png'));
const aspect = stretch ? prim.aspectCode(ref.w, ref.h) : 0;
if (stretch) ref = I.resize(ref, R, R);
const enc = prim.encode(ref, cfg, P);
const dec = prim.decoder(cfg, P);
const packets = enc.units.map(u => {
  const bits = [0, 1].concat(padBits(u, P)); // epoch = 1
  dec.apply(padBits(u, P));
  const bytes = [];
  for (let i = 0; i < NB; i++) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k]; bytes.push(v); }
  if (bytes[NB - 1] !== 0) throw new Error('last byte is not padding');
  bytes[NB - 1] = aspect;
  return bytes;
});
const L = prim.layout(cfg, P);
const name = `prim-${image}${stretch ? '-stretch' : ''}${R === 256 && nPrims === 1000 ? '' : `-r${R}-n${nPrims}`}${NB === 32 ? '' : `-b${NB}`}`;
fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ image, cfg, layout: L, bytes: NB, aspect, packets }));
I.savePNG(dec.render(), path.join(outDir, `${name}-expected.png`));
console.log(`wrote ${packets.length} packets, aspect ${aspect}, layout ${JSON.stringify(L)} -> ${outDir}/${name}.json`);
