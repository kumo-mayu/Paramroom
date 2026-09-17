'use strict';
// Export wire packets (32 bytes each, epoch 1) and the JS reference render of the prim codec for the Unity shader test.
// usage: node export-prim-test.js [image=kodim23] [out=../measure/unity/Assets/ImagePadMeasure/TestData]
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const prim = require('./codecs/prim');
const { padBits } = require('./lib/evaluate');

const image = process.argv[2] || 'kodim23';
const outDir = process.argv[3] || path.join(__dirname, '..', 'measure', 'unity', 'Assets', 'ImagePadMeasure', 'TestData');
fs.mkdirSync(outDir, { recursive: true });
const B = 256, P = B - 2;
const cfg = prim.configs(B).find(c => c.label === 'e9.8.6-c565a2-r256-n1000');
const ref = I.loadPNG(path.join(__dirname, 'images', 'ref', image + '.png'));
const enc = prim.encode(ref, cfg, P);
const dec = prim.decoder(cfg, P);
const packets = enc.units.map(u => {
  const bits = [0, 1].concat(padBits(u, P)); // epoch = 1
  dec.apply(padBits(u, P));
  const bytes = [];
  for (let i = 0; i < 32; i++) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k]; bytes.push(v); }
  return bytes;
});
const L = prim.layout(cfg, P);
fs.writeFileSync(path.join(outDir, `prim-${image}.json`), JSON.stringify({ image, cfg, layout: L, packets }));
I.savePNG(dec.render(), path.join(outDir, `prim-${image}-expected.png`));
console.log(`wrote ${packets.length} packets, layout ${JSON.stringify(L)} -> ${outDir}`);
