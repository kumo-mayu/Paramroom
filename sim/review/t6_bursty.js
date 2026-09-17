const path = require('path');
const I = require('../lib/image'); const M = require('../lib/metrics'); const T = require('../lib/transport');
const { loadCodec, padBits } = require('../lib/evaluate');
const ref = I.loadPNG(path.join(__dirname, '..', 'images', 'ref', 'kodim23.png'));
const B = 256, P = 254, H = 0.14, tMax = 40, times = [5, 10, 20, 40], SEEDS = 8;
function ge({ N, p, burst, seed }) { // stationary start
  const rnd = T.mulberry32(seed); const b = 1 / burst, a = p * b / (1 - p); let bad = rnd() < p; const out = [];
  for (let k = 0; (k + 1) * H <= tMax; k++) { if (!bad) out.push({ time: (k + 1) * H, unit: k % N }); bad = bad ? rnd() >= b : rnd() < a; }
  return out;
}
const codecs = [['wav', 'q12'], ['wavs', 'q12-m16'], ['wavs', 'q12-m4'], ['dctv', 'r256-s2'], ['dctf', 'r256-s2']];
const prep = codecs.map(([n, l]) => { const c = loadCodec(n); const cfg = c.configs(B).find(x => x.label === l); return { n, l, c, cfg, units: c.encode(ref, cfg, P).units.map(u => padBits(u, P)) }; });
for (const [p, burst] of [[0.05, 1], [0.05, 30], [0.2, 1], [0.2, 30]]) {
  console.log(`p=${p} mean burst=${burst} slots (${(burst * H).toFixed(1)} s)  [capSeconds=40]`);
  for (const x of prep) {
    const N = Math.min(x.units.length, Math.floor(40 / H));
    const acc = times.map(() => 0);
    for (let s = 1; s <= SEEDS; s++) {
      const arr = ge({ N, p, burst, seed: s * 101 }); const dec = x.c.decoder(x.cfg, P); let ai = 0;
      times.forEach((t, ti) => { while (ai < arr.length && arr[ai].time <= t) dec.apply(x.units[arr[ai++].unit]); acc[ti] += M.msssim(ref, dec.render()); });
    }
    console.log(`  ${(x.n + ':' + x.l).padEnd(16)} MS-SSIM ` + times.map((t, i) => `t${t}=${(acc[i] / SEEDS).toFixed(3)}`).join(' '));
  }
}
