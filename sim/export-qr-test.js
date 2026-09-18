'use strict';
// Export wire packets and the reference render of the QR mode, for the Unity shader test (docs/research/09).
// The QR mode shares the packets and the store with the picture mode; only the way a canvas pixel gets its colour
// differs, so the same test harness (ImagePadPrimTest) can check it.
//   node export-qr-test.js "<text>" [out=../measure/unity/Assets/ImagePadMeasure/TestData] [--ec M] [--R 512] [--bytes 32]
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const I = require('./lib/image');
const prim = require('./codecs/prim');
const qrmode = require('./codecs/qrmode');

const opt = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const text = process.argv[2] || 'https://example.com/abc';
const R = Number(opt('R', 512)), NB = Number(opt('bytes', 32)), ec = opt('ec', 'M');
const outDir = process.argv[3] && !process.argv[3].startsWith('--')
  ? process.argv[3] : path.join(__dirname, '..', 'measure', 'unity', 'Assets', 'ImagePadMeasure', 'TestData');
fs.mkdirSync(outDir, { recursive: true });
const P = 8 * NB - 2;

// the same field widths as decoder format 3, so the packets fit a prefab built for pictures
const primCfg = { ...prim.cfgOf({ shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, R, maxPrims: 4000 }), out: R };
const L0 = prim.layout(primCfg, P);
const cfg = { R, primBits: L0.primBits, maxPrims: L0.maxPrims };

const q = QRCode.create(text, { errorCorrectionLevel: ec });
const n = q.modules.size;
const modules = new Uint8Array(n * n);
for (let i = 0; i < n * n; i++) modules[i] = q.modules.data[i] ? 1 : 0;

const enc = qrmode.encode(modules, n, cfg, P, 128);   // aspect 128 = 1:1, a QR code is square
const dec = qrmode.decoder(cfg, P);
const packets = enc.units.map(u => {
  dec.apply(u);
  const bits = [0, 1].concat(u);          // epoch = 1
  const bytes = [];
  for (let i = 0; i < NB; i++) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k]; bytes.push(v); }
  return bytes;
});

const name = `qr-${n}x${n}${R === 512 ? '' : `-r${R}`}${NB === 32 ? '' : `-b${NB}`}`;
fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({
  text, ec, modules: n, cfg: primCfg, layout: enc.layout, bytes: NB, aspect: 128, mode: 'qr', packets,
}));
I.savePNG(I.quantize8(dec.render()), path.join(outDir, `${name}-expected.png`));
console.log(`"${text}" -> QR ${n}x${n}, ${packets.length} packets (${(packets.length * 0.1).toFixed(1)} s) -> ${outDir}/${name}.json`);
