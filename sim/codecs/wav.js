'use strict';
// WAV: CDF 9/7 wavelet (5 levels on 256x256, LL = 8x8), YCbCr, self-contained VLC packets.
//
// Streams groups in static coarse-to-fine order: LL(Y,Cb,Cr) dense, then detail subbands of each
// level (Y first; chroma one level "later"). Uniform pixel-domain quantization: each subband's step is
// scaled by the inverse of its synthesis basis norm. Deadzone quantizer (rounding offset 0.5-dz).
// Missing coefficients are 0 => missing detail = local blur (no holes), missing LL = dark/grey area.
// Shader side: coefficient texture(s) + inverse transform as per-level separable synthesis passes
// (can be spread over frames in a camera loop).
const I = require('../lib/image');
const PC = require('./packet-coder');
const { trainingImages } = require('./training');

const SIZE = 256;
const LEVELS = 5;
const A1 = -1.586134342, A2 = -0.05298011854, A3 = 0.8829110762, A4 = 0.4435068522, KS = 1.149604398;

// 1D lifting on arr[off + i*stride], length n (even), symmetric extension.
function fwd1d(x, n) {
  const at = i => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
  for (let i = 1; i < n; i += 2) x[i] += A1 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 0; i < n; i += 2) x[i] += A2 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 1; i < n; i += 2) x[i] += A3 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 0; i < n; i += 2) x[i] += A4 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 0; i < n; i++) x[i] = i % 2 ? x[i] / KS : x[i] * KS;
}
function inv1d(x, n) {
  const at = i => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
  for (let i = 0; i < n; i++) x[i] = i % 2 ? x[i] * KS : x[i] / KS;
  for (let i = 0; i < n; i += 2) x[i] -= A4 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 1; i < n; i += 2) x[i] -= A3 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 0; i < n; i += 2) x[i] -= A2 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 1; i < n; i += 2) x[i] -= A1 * (x[at(i - 1)] + x[at(i + 1)]);
}
// Interleaved (in-place, Mallat-free) 2D layout would complicate subbands; use packed Mallat layout.
function fwd2d(plane) {
  const d = Float64Array.from(plane);
  let n = SIZE;
  const buf = new Float64Array(SIZE), tmp = new Float64Array(SIZE);
  for (let l = 0; l < LEVELS; l++, n >>= 1) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) buf[x] = d[y * SIZE + x];
      fwd1d(buf, n);
      for (let i = 0; i < n / 2; i++) { d[y * SIZE + i] = buf[2 * i]; tmp[i] = buf[2 * i + 1]; }
      for (let i = 0; i < n / 2; i++) d[y * SIZE + n / 2 + i] = tmp[i];
    }
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) buf[y] = d[y * SIZE + x];
      fwd1d(buf, n);
      for (let i = 0; i < n / 2; i++) { d[i * SIZE + x] = buf[2 * i]; tmp[i] = buf[2 * i + 1]; }
      for (let i = 0; i < n / 2; i++) d[(n / 2 + i) * SIZE + x] = tmp[i];
    }
  }
  return d;
}
function inv2d(coef) {
  const d = Float64Array.from(coef);
  const buf = new Float64Array(SIZE);
  for (let l = LEVELS - 1; l >= 0; l--) {
    const n = SIZE >> l, h = n / 2;
    for (let x = 0; x < n; x++) {
      for (let i = 0; i < h; i++) { buf[2 * i] = d[i * SIZE + x]; buf[2 * i + 1] = d[(h + i) * SIZE + x]; }
      inv1d(buf, n);
      for (let y = 0; y < n; y++) d[y * SIZE + x] = buf[y];
    }
    for (let y = 0; y < n; y++) {
      for (let i = 0; i < h; i++) { buf[2 * i] = d[y * SIZE + i]; buf[2 * i + 1] = d[y * SIZE + h + i]; }
      inv1d(buf, n);
      for (let x = 0; x < n; x++) d[y * SIZE + x] = buf[x];
    }
  }
  return d;
}

// Subband rectangles in Mallat layout. level 1 = finest.
function subbands() {
  const out = [];
  const s = SIZE >> LEVELS;
  out.push({ level: LEVELS, orient: 'LL', x: 0, y: 0, w: s, h: s });
  for (let l = LEVELS; l >= 1; l--) {
    const h = SIZE >> l;
    out.push({ level: l, orient: 'HL', x: h, y: 0, w: h, h });
    out.push({ level: l, orient: 'LH', x: 0, y: h, w: h, h });
    out.push({ level: l, orient: 'HH', x: h, y: h, w: h, h });
  }
  return out;
}

// synthesis basis norm per subband (impulse response energy)
const norms = (() => {
  return subbands().map(sb => {
    const c = new Float64Array(SIZE * SIZE);
    c[(sb.y + (sb.h >> 1)) * SIZE + sb.x + (sb.w >> 1)] = 1;
    const r = inv2d(c);
    let e = 0;
    for (const v of r) e += v * v;
    return Math.sqrt(e);
  });
})();

function makeLayout(cfg) {
  const sbs = subbands();
  const groups = [];
  for (let ch = 0; ch < 3; ch++)
    sbs.forEach((sb, si) => {
      if (ch > 0 && sb.level <= cfg.chromaDrop) return; // chroma finest levels never sent
      const key = sb.orient === 'LL' ? -1 : (LEVELS - sb.level) + (ch ? 1.5 : 0);
      groups.push({ ch, si, sb, key, tie: ch * 10 + si });
    });
  groups.sort((a, b) => a.key - b.key || a.tie - b.tie);
  let pos = 0;
  for (const g of groups) {
    g.start = pos; g.nb = g.sb.w * g.sb.h; pos += g.nb;
    g.step = cfg.step * (g.ch ? cfg.chromaW : 1) / norms[g.si];
  }
  const posGroup = new Int32Array(pos);
  groups.forEach((g, gi) => posGroup.fill(gi, g.start, g.start + g.nb));
  const denseEnd = groups.filter(g => g.sb.orient === 'LL').reduce((m, g) => Math.max(m, g.start + g.nb), 0);
  return { groups, total: pos, posGroup, denseEnd };
}

// RGB-MSE weight of each YCbCr channel (from the inverse colour transform)
const CH_W = [1, (0.344136 ** 2 + 1.772 ** 2) / 3, (1.402 ** 2 + 0.714136 ** 2) / 3];

// Returns q; if gains is given, fills gains[pos] = squared-error reduction from receiving pos.
function quantize(ref, layout, cfg, gains) {
  const planes = I.rgbToYcc(I.resize(ref, SIZE, SIZE)).map(p => fwd2d(p.data.map(v => v - 128)));
  const q = new Int32Array(layout.total);
  const off = 0.5 - cfg.dz;
  for (const g of layout.groups) {
    const src = planes[g.ch], sb = g.sb;
    for (let y = 0; y < sb.h; y++)
      for (let x = 0; x < sb.w; x++) {
        const c = src[(sb.y + y) * SIZE + sb.x + x] / g.step;
        const v = Math.sign(c) * Math.floor(Math.abs(c) + (sb.orient === 'LL' ? 0.5 : off));
        q[g.start + y * sb.w + x] = v;
        if (gains) gains[g.start + y * sb.w + x] = CH_W[g.ch] * g.step * g.step * (c * c - (c - v) * (c - v));
      }
  }
  return q;
}

function reconstruct(q, layout, cfg) {
  const coefs = [0, 1, 2].map(() => new Float64Array(SIZE * SIZE));
  for (const g of layout.groups) {
    const dst = coefs[g.ch], sb = g.sb;
    for (let y = 0; y < sb.h; y++)
      for (let x = 0; x < sb.w; x++) {
        const v = q[g.start + y * sb.w + x];
        if (v) dst[(sb.y + y) * SIZE + sb.x + x] = v * g.step;
      }
  }
  const [Y, Cb, Cr] = coefs.map(c => {
    const p = inv2d(c);
    for (let i = 0; i < p.length; i++) p[i] += 128;
    return { w: SIZE, h: SIZE, c: 1, data: p };
  });
  return I.quantize8(I.yccToRgb(Y, Cb, Cr));
}

// Sort runs by distortion reduction (descending). spans: [start,end) positions per run.
function rdOrder(spans, gains) {
  return rdOrderWithGains(spans, gains).order;
}
// returns { order, runGains } (runGains indexed by run, not by order)
function rdOrderWithGains(spans, gains) {
  const pre = new Float64Array(gains.length + 1);
  for (let i = 0; i < gains.length; i++) pre[i + 1] = pre[i] + gains[i];
  const g = spans.map(([a, b]) => pre[b] - pre[a]);
  return { order: g.map((v, i) => i).sort((i, j) => g[j] - g[i] || i - j), runGains: g };
}

const cache = new Map();
function setup(cfg) {
  const key = `${cfg.step}/${cfg.chromaW}/${cfg.chromaDrop}/${cfg.dz}`;
  if (!cache.has(key)) {
    const layout = makeLayout(cfg);
    const tab = PC.train(layout, trainingImages().map(img => quantize(img, layout, cfg)));
    cache.set(key, { layout, tab });
  }
  return cache.get(key);
}

module.exports = {
  name: 'wav',
  _internal: { fwd2d, inv2d, norms, subbands, setup, quantize, reconstruct, rdOrder, rdOrderWithGains },
  configs(B) {
    const steps = B >= 128 ? [6, 12, 24] : B >= 64 ? [12, 24, 48] : [24, 48, 96];
    const idxMax = B >= 128 ? 10 : 8;
    const out = [];
    for (const rd of [false, true])
      for (const step of steps) out.push({ label: `q${step}${rd ? '-rd' : ''}`, step, chromaW: 2, chromaDrop: 1, dz: 0.2, idxMax, adapt: false, rd });
    return out;
  },
  encode(ref, cfg, P) {
    const { layout, tab } = setup(cfg);
    const gains = new Float64Array(layout.total);
    const q = quantize(ref, layout, cfg, gains);
    const { runs, baseRuns, spans } = PC.encodeStream(layout, tab, q, P, cfg);
    if (!cfg.rd) return { units: runs, baseCount: baseRuns };
    return { units: rdOrder(spans, gains).map(i => runs[i]), baseCount: 0 };
  },
  decoder(cfg, P) {
    const { layout, tab } = setup(cfg);
    const q = new Int32Array(layout.total);
    return {
      stateInfo: `coef texture ${layout.total}`,
      apply(bits) { PC.apply(layout, tab, q, bits, cfg); },
      render() { return reconstruct(q, layout, cfg); },
    };
  },
};
