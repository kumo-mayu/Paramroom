'use strict';
// Sanity check: encode, decode all units (shuffled order), compare with metrics; save full decode.
// usage: node selftest.js codec B image [cfgLabelRegex]
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const M = require('./lib/metrics');
const T = require('./lib/transport');
const { loadCodec, padBits } = require('./lib/evaluate');

const [codecName = 'dctv', Bs = '256', image = 'kodim23', cfgRe] = process.argv.slice(2);
const codec = loadCodec(codecName);
const B = Number(Bs), P = B - T.EPOCH_BITS;
const ref = I.loadPNG(path.join(__dirname, 'images', 'ref', image + '.png'));
fs.mkdirSync(path.join(__dirname, 'out', 'selftest'), { recursive: true });
for (const cfg of codec.configs(B)) {
  if (cfgRe && !new RegExp(cfgRe).test(cfg.label)) continue;
  const t0 = Date.now();
  const enc = codec.encode(ref, cfg, P);
  const encMs = Date.now() - t0;
  const units = enc.units.map(u => padBits(u, P));
  const order = units.map((_, i) => i);
  const rnd = T.mulberry32(1);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const decA = codec.decoder(cfg, P), decB = codec.decoder(cfg, P);
  units.forEach(u => decA.apply(u));
  order.forEach(i => { decB.apply(units[i]); decB.apply(units[i]); });
  const a = decA.render(), b = decB.render();
  let diff = 0;
  for (let i = 0; i < a.data.length; i++) diff = Math.max(diff, Math.abs(a.data[i] - b.data[i]));
  const m = M.all(ref, a);
  I.savePNG(a, path.join(__dirname, 'out', 'selftest', `${image}-${codecName}-${B}-${cfg.label}.png`));
  const kbits = units.length * B / 1000;
  console.log(`${cfg.label.padEnd(12)} units=${String(units.length).padStart(5)} base=${enc.baseCount} ${kbits.toFixed(1)}kbit  full: psnr=${m.psnr.toFixed(2)} ssim=${m.ssim.toFixed(3)} ms=${m.msssim.toFixed(3)}  orderDiff=${diff} enc=${encMs}ms  sec@0.14=${(units.length * 0.14).toFixed(0)}`);
}
