// Torn (non-atomic) packet: first j bytes from unit k+1, rest from unit k (or vice versa).
// Apply to a fully-decoded state, then re-apply one full clean carousel cycle. Does damage persist?
const path = require('path');
const I = require('../lib/image'); const M = require('../lib/metrics'); const T = require('../lib/transport');
const { loadCodec, padBits } = require('../lib/evaluate');
const img = process.argv[2] || 'kodim23';
const ref = I.loadPNG(path.join(__dirname, '..', 'images', 'ref', img + '.png'));
const B = Number(process.argv[3] || 256), P = B - T.EPOCH_BITS;
const rows = [['wav', 'q12'], ['wav', 'q12-rd'], ['dctv', B >= 128 ? 'r256-s2' : 'r256-s4'], ['dctf', B >= 128 ? 'r256-s2' : 'r256-s4'], ['pal', 'g64-k5'], ['wavs', B>=64?'q12-m16':'q24-m16-u10']];
const rnd = T.mulberry32(3);
for (const [name, label] of rows) {
  const codec = loadCodec(name); const cfg = codec.configs(B).find(c => c.label === label);
  if (!cfg) { console.log('no cfg', name, label); continue; }
  const units = codec.encode(ref, cfg, P).units.map(u => padBits(u, P));
  const clean = codec.decoder(cfg, P); units.forEach(u => clean.apply(u));
  const cleanImg = clean.render(); const cleanPsnr = M.psnr(ref, cleanImg);
  let persist = 0, sumLoss = 0, worst = 0; const trials = 60;
  for (let t = 0; t < trials; t++) {
    const k = Math.floor(rnd() * (units.length - 1));
    const j = 8 * (1 + Math.floor(rnd() * (Math.floor(B / 8) - 1))) - T.EPOCH_BITS; // tear at a param boundary
    const torn = units[k + 1].slice(0, j).concat(units[k].slice(j));
    const d = codec.decoder(cfg, P); units.forEach(u => d.apply(u));
    d.apply(torn);
    units.forEach(u => d.apply(u)); // one more full clean cycle
    const im = d.render(); let diff = 0; for (let i = 0; i < im.data.length; i++) if (im.data[i] !== cleanImg.data[i]) diff++;
    if (diff) { persist++; const l = cleanPsnr - M.psnr(ref, im); sumLoss += l; worst = Math.max(worst, l); }
  }
  console.log(`B=${B} ${name}:${label} units=${units.length} torn packets leaving PERMANENT damage after a full clean cycle: ${persist}/${trials}, mean dPSNR(when damaged)=${persist ? (sumLoss / persist).toFixed(2) : 0} dB, worst=${worst.toFixed(2)} dB`);
}
