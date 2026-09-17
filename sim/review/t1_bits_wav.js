const { BitWriter, BitReader } = require('../lib/bits');
const T = require('../lib/transport');
const rnd = T.mulberry32(5);
// 1. EG/SEG roundtrip
let bad = 0;
for (let it = 0; it < 20000; it++) {
  const w = new BitWriter(); const vals = [];
  for (let j = 0; j < 20; j++) { const k = Math.floor(rnd() * 7); const v = Math.floor((rnd() - 0.5) * 2 * (1 << Math.floor(rnd() * 14))); vals.push([k, v]); w.writeSEG(v, k); if (w.length !== vals.reduce((s,[kk,vv])=>s+BitWriter.segLength(vv,kk),0)) bad++; }
  const r = new BitReader(w.bits); for (const [k, v] of vals) if (r.readSEG(k) !== v) bad++;
}
console.log('SEG roundtrip errors', bad);
// writeSigned edge
{ const w = new BitWriter(); w.writeSigned(-2, 2); w.writeSigned(1,2); const r = new BitReader(w.bits); console.log('signed', r.readSigned(2), r.readSigned(2)); }
// 2. wavelet PR and norms, LL magnitude
const W = require('../codecs/wav')._internal;
const x = new Float64Array(65536).map(() => (rnd() - 0.5) * 255);
const y = W.inv2d(W.fwd2d(x)); let e = 0; for (let i = 0; i < x.length; i++) e = Math.max(e, Math.abs(x[i] - y[i]));
console.log('wavelet PR max err', e);
console.log('norms', W.subbands().map((s, i) => `${s.orient}${s.level}:${W.norms[i].toFixed(3)}`).join(' '));
const c = W.fwd2d(new Float64Array(65536).fill(127)); console.log('LL coef for const 127 plane', c[0].toFixed(1));
