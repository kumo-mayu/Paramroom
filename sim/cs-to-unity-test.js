'use strict';
// Turns units encoded by the C# encoder (imagepad encode --format N [--bytes B] --out x.json) into test data for the
// Unity decoder test (ImagePadPrimTest): wire packets (epoch 1, aspect in the last byte), the layout, the field widths
// and the JS decoder's render as the expected display.
// usage: node cs-to-unity-test.js <units.json> <name> [out=../measure/unity/Assets/ImagePadMeasure/TestData]
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const prim = require('./codecs/prim');

const [file, name, outArg] = process.argv.slice(2);
const outDir = outArg || path.join(__dirname, '..', 'measure', 'unity', 'Assets', 'ImagePadMeasure', 'TestData');
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const NB = j.bytes || 32, P = 8 * NB - 2;
const cfg = { ...prim.cfgOf({ shape: 'ell', cb: j.cb, rb: j.rb, ab: j.ab, col: j.col, aBits: j.aBits, R: j.R, maxPrims: j.capacity || j.n }), out: j.R };
const L = prim.layout(cfg, P);
const dec = prim.decoder(cfg, P);
const packets = j.units.map(s => {
  const u = [...s].map(Number);
  dec.apply(u);
  const bits = [0, 1].concat(u);
  const bytes = [];
  for (let i = 0; i < NB; i++) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | (bits[i * 8 + k] || 0); bytes.push(v); }
  bytes[NB - 1] = j.aspect;
  return bytes;
});
fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ image: j.image, cfg, layout: L, bytes: NB, aspect: j.aspect, packets }));
I.savePNG(dec.render(), path.join(outDir, `${name}-expected.png`));
console.log(`wrote ${name}: ${packets.length} packets x ${NB} Int, ${L.primBits} bit primitives, k=${L.k}, capacity ${L.maxPrims}`);
