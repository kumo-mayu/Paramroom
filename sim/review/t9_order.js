const path = require('path');
const I = require('../lib/image'); const T = require('../lib/transport');
const { loadCodec, padBits } = require('../lib/evaluate');
const ref = I.loadPNG(path.join(__dirname, '..', 'images', 'ref', 'illust_tux.png'));
const rnd = T.mulberry32(77);
for (const B of [256, 32]) for (const [n, l] of [['wav', B > 64 ? 'q12' : 'q48'], ['wav', B > 64 ? 'q12-rd' : 'q48-rd'], ['wavs', B > 64 ? 'q12-m4' : 'q48-m4-u10'], ['dctv', 'r256-s4'], ['dctf', 'r256-s4'], ['pal', 'g64-k5']]) {
  const c = loadCodec(n); const cfg = c.configs(B).find(x => x.label === l); const P = B - 2;
  const units = c.encode(ref, cfg, P).units.map(u => padBits(u, P));
  let maxd = 0;
  for (let t = 0; t < 4; t++) {
    const sub = units.map((_, i) => i).filter(() => rnd() < 0.4);
    const sh = sub.slice(); for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    const a = c.decoder(cfg, P), b = c.decoder(cfg, P); sub.forEach(i => a.apply(units[i])); sh.forEach(i => { b.apply(units[i]); if (rnd() < 0.3) b.apply(units[i]); });
    const ia = a.render(), ib = b.render(); for (let i = 0; i < ia.data.length; i++) maxd = Math.max(maxd, Math.abs(ia.data[i] - ib.data[i]));
  }
  console.log(`B=${B} ${n}:${l} random-subset order/duplicate max pixel diff = ${maxd}`);
}
// prio schedule sanity
const N = 50, base = 5, s = T.makeSchedule(N, { type: 'prio', period: 4 }, base); const cnt = new Array(N).fill(0);
for (let k = 0; k < 4000; k++) cnt[s(k)]++;
console.log('prio counts base', cnt.slice(0, base).join(','), 'others min/max', Math.min(...cnt.slice(base)), Math.max(...cnt.slice(base)));
// late-join slot boundary: slot straddling join is discarded
console.log('join=30,H=0.14 first arrival', T.arrivals({ N: 10, schedule: k => k % 10, H: 0.14, p: 0, join: 30, tMax: 1, seed: 1 })[0]);
