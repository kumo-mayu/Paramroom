const path = require('path');
const I = require('../lib/image'); const M = require('../lib/metrics'); const T = require('../lib/transport');
const { loadCodec, padBits } = require('../lib/evaluate');
const ref = I.loadPNG(path.join(__dirname, '..', 'images', 'ref', 'kodim23.png'));
const H = 0.14, P = 254;
for (const [n, l] of [['wav', 'q12'], ['wav', 'q12-rd'], ['dctv', 'r256-s2']]) {
  const c = loadCodec(n); const cfg = c.configs(256).find(x => x.label === l); const units = c.encode(ref, cfg, P).units.map(u => padBits(u, P));
  const N = Math.min(units.length, Math.floor(60 / H)); const v = [];
  for (let s = 1; s <= 16; s++) { const arr = T.arrivals({ N, schedule: k => k % N, H, p: 0.2, join: 0, tMax: 10, seed: s * 7919 }); const d = c.decoder(cfg, P); arr.forEach(a => d.apply(units[a.unit])); v.push(M.msssim(ref, d.render())); }
  const m = v.reduce((a, b) => a + b) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
  console.log(`${n}:${l} p=0.2 t=10 MS-SSIM over 16 seeds: mean=${m.toFixed(3)} sd=${sd.toFixed(3)} min=${Math.min(...v).toFixed(3)} max=${Math.max(...v).toFixed(3)} seeds1-2=${v.slice(0, 2).map(x => x.toFixed(3))}`);
}
