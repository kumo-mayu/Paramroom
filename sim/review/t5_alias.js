const T = require('../lib/transport');
function sampler({ N, H, Ts, jit, seed, tMax }) {
  const rnd = T.mulberry32(seed); const out = []; let s = 0.0371, last = -1;
  while (s <= tMax) { const k = Math.floor(s / H + 1e-9); if (k !== last) { out.push({ time: s, unit: k % N, k }); last = k; } s += Ts + (rnd() - 0.5) * 2 * jit; }
  return out;
}
const tMax = 60;
for (const [H, Ts] of [[0.14, 0.16], [7/60, 0.125], [0.2, 0.2 + 1/90]]) for (const jit of [0, 0.0005, 0.002]) for (const N of [100, 104, 112, 120, 128]) {
  const sa = sampler({ N, H, Ts, jit, seed: 9, tMax });
  const slots = Math.floor(tMax / H); const rate = 1 - sa.length / slots;
  const never = N - new Set(sa.map(a => a.unit)).size;
  let neverIid = 0; for (let seed = 1; seed <= 20; seed++) { const ia = T.arrivals({ N, schedule: k => k % N, H, p: rate, join: 0, tMax, seed: seed * 7919 }); neverIid += N - new Set(ia.map(a => a.unit)).size; }
  if (never || jit === 0) console.log(`H=${H.toFixed(3)} Ts=${Ts.toFixed(3)} jit=${jit * 1000}ms N=${N} cycles=${(slots / N).toFixed(1)} loss=${(rate * 100).toFixed(1)}%  never-received: sampler=${never}  iid(mean 20 seeds)=${(neverIid / 20).toFixed(2)}`);
}
