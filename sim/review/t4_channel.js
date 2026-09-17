// Compare iid loss (as in lib/transport.js) with (a) snapshot sampler with jitter, (b) Gilbert-Elliott bursts,
// at matched mean loss. Codec: wav q12 vs wavs q12-m16 (B=256), dctf r256-s2, kodim23, carousel.
const path = require('path');
const I = require('../lib/image'); const M = require('../lib/metrics'); const T = require('../lib/transport');
const { loadCodec, padBits } = require('../lib/evaluate');
const ref = I.loadPNG(path.join(__dirname, '..', 'images', 'ref', 'kodim23.png'));
const B = 256, P = B - 2, tMax = 60;

// (a) sampler: sender switches unit at k*H; receiver-visible snapshots at jittered ticks of mean period Ts.
function sampler({ N, H, Ts, jit, seed }) {
  const rnd = T.mulberry32(seed); const out = []; let s = rnd() * Ts, last = -1;
  while (s <= tMax) { const k = Math.floor(s / H); if (k !== last) { out.push({ time: s, unit: k % N }); last = k; } s += Ts + (rnd() - 0.5) * 2 * jit; }
  return out;
}
// (b) Gilbert-Elliott: good->bad with prob a, bad->good with prob b; loss only in bad. mean loss = a/(a+b), mean burst = 1/b
function ge({ N, H, p, burst, seed }) {
  const rnd = T.mulberry32(seed); const b = 1 / burst, a = p * b / (1 - p); let bad = rnd() < p; const out = [];
  for (let k = 0; (k + 1) * H <= tMax; k++) { if (!bad) out.push({ time: (k + 1) * H, unit: k % N }); bad = bad ? rnd() >= b : rnd() < a; }
  return out;
}
function run(name, label, arrFn, times) {
  const codec = loadCodec(name); const cfg = codec.configs(B).find(c => c.label === label);
  const units = codec.encode(ref, cfg, P).units.map(u => padBits(u, P));
  const N = units.length; const arr = arrFn(N); const dec = codec.decoder(cfg, P); const got = new Set(); let ai = 0;
  const lossRate = 1 - arr.length / Math.floor(tMax / 0.14);
  return times.map(t => { while (ai < arr.length && arr[ai].time <= t) { dec.apply(units[arr[ai].unit]); got.add(arr[ai].unit); ai++; } return `t${t}:${M.psnr(ref, dec.render()).toFixed(1)}dB/${got.size}u`; }).join(' ') + ` (N=${N})`;
}
const times = [10, 20, 40, 60];
for (const [name, label] of [['wav', 'q12'], ['wavs', 'q12-m16'], ['wavs', 'q12-m4'], ['dctf', 'r256-s2']]) {
  const H = 0.14;
  const avg = f => f; // single seed, illustrative
  console.log(`${name}:${label}`);
  console.log('  iid p=0.2       ', run(name, label, N => T.arrivals({ N, schedule: k => k % N, H, p: 0.2, join: 0, tMax, seed: 7919 }), times));
  console.log('  GE p=0.2 burst=30', run(name, label, N => ge({ N, H, p: 0.2, burst: 30, seed: 11 }), times));
  console.log('  sampler Ts=0.16 jit=5ms (~12.5% loss)', run(name, label, N => sampler({ N, H, Ts: 0.16, jit: 0.005, seed: 5 }), times));
}
// aliasing: which units are never received after many cycles, sampler vs iid at the same loss rate
for (const N of [100, 105, 112, 150]) {
  const H = 0.14, Ts = 0.16;
  const cnt = (arr) => { const s = new Set(arr.map(a => a.unit)); return N - s.size; };
  const tm = 60; // ~4-6 cycles
  const sa = sampler({ N, H, Ts, jit: 0.0005, seed: 9 }); const rate = 1 - sa.length / Math.floor(tMax / H);
  const ia = T.arrivals({ N, schedule: k => k % N, H, p: rate, join: 0, tMax, seed: 7919 });
  console.log(`N=${N} (cycles=${(tMax / H / N).toFixed(1)}) loss=${(rate * 100).toFixed(1)}%  units never received after 60s: sampler(jitter 0.5ms)=${cnt(sa)}  iid=${cnt(ia)}`);
}
