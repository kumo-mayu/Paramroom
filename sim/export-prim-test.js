'use strict';
// Export wire packets (32 bytes each, epoch 1) and the JS reference render of the prim codec for the Unity shader test.
// usage: node export-prim-test.js [image=kodim23] [out=../measure/unity/Assets/ImagePadMeasure/TestData] [--stretch]
//   default: images/ref/<image>.png (256x256, aspect byte 0 = 1:1, as before)
//   --stretch: images/src/<image>.png stretched to 256x256, aspect code (prim.aspectCode) in the last byte; the file
//              name gets a "-stretch" suffix and the JSON an "aspect" field.
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const prim = require('./codecs/prim');
const { padBits } = require('./lib/evaluate');

const argv = process.argv.slice(2).filter(a => !a.startsWith('--'));
const stretch = process.argv.includes('--stretch');
const image = argv[0] || 'kodim23';
const outDir = argv[1] || path.join(__dirname, '..', 'measure', 'unity', 'Assets', 'ImagePadMeasure', 'TestData');
fs.mkdirSync(outDir, { recursive: true });
const B = 256, P = B - 2;
const cfg = prim.configs(B).find(c => c.label === 'e9.8.6-c565a2-r256-n1000');
let ref = I.loadPNG(path.join(__dirname, 'images', stretch ? 'src' : 'ref', image + '.png'));
const aspect = stretch ? prim.aspectCode(ref.w, ref.h) : 0;
if (stretch) ref = I.resize(ref, 256, 256);
const enc = prim.encode(ref, cfg, P);
const dec = prim.decoder(cfg, P);
const packets = enc.units.map(u => {
  const bits = [0, 1].concat(padBits(u, P)); // epoch = 1
  dec.apply(padBits(u, P));
  const bytes = [];
  for (let i = 0; i < 32; i++) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k]; bytes.push(v); }
  if (bytes[31] !== 0) throw new Error('last byte is not padding');
  bytes[31] = aspect;
  return bytes;
});
const L = prim.layout(cfg, P);
const name = `prim-${image}${stretch ? '-stretch' : ''}`;
fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ image, cfg, layout: L, aspect, packets }));
I.savePNG(dec.render(), path.join(outDir, `${name}-expected.png`));
console.log(`wrote ${packets.length} packets, aspect ${aspect}, layout ${JSON.stringify(L)} -> ${outDir}/${name}.json`);
