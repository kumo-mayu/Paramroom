// Emulate a GPU inverse 9/7 whose intermediate RT is RGBAHalf (16-bit float) vs RFloat.
const path = require('path');
const I = require('../lib/image'); const M = require('../lib/metrics');
const W = require('../codecs/wav'); const Wi = W._internal;
const { padBits } = require('../lib/evaluate');
const A1 = -1.586134342, A2 = -0.05298011854, A3 = 0.8829110762, A4 = 0.4435068522, KS = 1.149604398, SIZE = 256;
const half = v => { if (v === 0) return 0; const e = Math.max(-10, Math.floor(Math.log2(Math.abs(v)))); const u = Math.pow(2, e - 10); return Math.round(v / u) * u; };
function inv1d(x, n, R) { const at = i => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
  for (let i = 0; i < n; i++) x[i] = R(i % 2 ? x[i] * KS : x[i] / KS);
  for (let i = 0; i < n; i += 2) x[i] = R(x[i] - A4 * (x[at(i - 1)] + x[at(i + 1)]));
  for (let i = 1; i < n; i += 2) x[i] = R(x[i] - A3 * (x[at(i - 1)] + x[at(i + 1)]));
  for (let i = 0; i < n; i += 2) x[i] = R(x[i] - A2 * (x[at(i - 1)] + x[at(i + 1)]));
  for (let i = 1; i < n; i += 2) x[i] = R(x[i] - A1 * (x[at(i - 1)] + x[at(i + 1)])); }
function inv2d(coef, R) { const d = Float64Array.from(coef, R); const buf = new Float64Array(SIZE);
  for (let l = 4; l >= 0; l--) { const n = SIZE >> l, h = n / 2;
    for (let x = 0; x < n; x++) { for (let i = 0; i < h; i++) { buf[2 * i] = d[i * SIZE + x]; buf[2 * i + 1] = d[(h + i) * SIZE + x]; } inv1d(buf, n, R); for (let y = 0; y < n; y++) d[y * SIZE + x] = buf[y]; }
    for (let y = 0; y < n; y++) { for (let i = 0; i < h; i++) { buf[2 * i] = d[y * SIZE + i]; buf[2 * i + 1] = d[y * SIZE + h + i]; } inv1d(buf, n, R); for (let x = 0; x < n; x++) d[y * SIZE + x] = buf[x]; } }
  return d; }
for (const im of ['kodim23', 'screenshot_wikipedia']) {
  const ref = I.loadPNG(path.join(__dirname, '..', 'images', 'ref', im + '.png'));
  const cfg = W.configs(256).find(c => c.label === 'q6');
  const { layout } = Wi.setup(cfg); const q = Wi.quantize(ref, layout, cfg);
  const coefs = [0, 1, 2].map(() => new Float64Array(SIZE * SIZE));
  for (const g of layout.groups) for (let y = 0; y < g.sb.h; y++) for (let x = 0; x < g.sb.w; x++) { const v = q[g.start + y * g.sb.w + x]; if (v) coefs[g.ch][(g.sb.y + y) * SIZE + g.sb.x + x] = v * g.step; }
  let maxc = 0; coefs.forEach(c => c.forEach(v => maxc = Math.max(maxc, Math.abs(v))));
  const recon = R => { const [Y, Cb, Cr] = coefs.map(c => { const p = inv2d(c, R); for (let i = 0; i < p.length; i++) p[i] += 128; return { w: SIZE, h: SIZE, c: 1, data: p }; }); return I.quantize8(I.yccToRgb(Y, Cb, Cr)); };
  const a = recon(v => v), b = recon(half), f32 = recon(Math.fround);
  let mx = 0, mx32 = 0; for (let i = 0; i < a.data.length; i++) { mx = Math.max(mx, Math.abs(a.data[i] - b.data[i])); mx32 = Math.max(mx32, Math.abs(a.data[i] - f32.data[i])); }
  console.log(`${im} wav q6: max |coef|=${maxc.toFixed(0)}; PSNR float64=${M.psnr(ref, a).toFixed(2)} half=${M.psnr(ref, b).toFixed(2)} (max pixel diff ${mx}) float32 max diff=${mx32}`);
}
