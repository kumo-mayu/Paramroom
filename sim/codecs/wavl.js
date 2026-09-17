'use strict';
// WAVL: layered (quality-scalable) wavelet. Same transform/packets as WAV, but the coefficients are
// coded in L quality layers: layer 0 quantizes with step D0, layer i>0 quantizes the residual left by
// layers < i with a finer step Di. Decoder value = sum over layers of q_i * D_i (each layer has its own
// coefficient plane, so packets stay idempotent and order independent; a layer-i packet without the
// lower layers only adds a small residual). Packets of all layers are sent in RD (gain) order, so the
// stream is close to embedded: coarse everywhere first, refinement later.
// Group id = (layer, channel, subband); layer 0 LL is dense (DPCM), everything else sparse.
const I = require('../lib/image');
const PC = require('./packet-coder');
const { trainingImages } = require('./training');
const W = require('./wav')._internal;

const SIZE = 256;
const LEVELS = 5;
const CH_W = [1, (0.344136 ** 2 + 1.772 ** 2) / 3, (1.402 ** 2 + 0.714136 ** 2) / 3];

function makeLayout(cfg) {
  const sbs = W.subbands();
  const groups = [];
  cfg.steps.forEach((step, layer) => {
    for (let ch = 0; ch < 3; ch++)
      sbs.forEach((sb, si) => {
        if (ch > 0 && sb.level <= cfg.chromaDrop) return;
        const key = layer * 100 + (sb.orient === 'LL' ? -1 : (LEVELS - sb.level) + (ch ? 1.5 : 0));
        groups.push({ layer, ch, si, sb, key, tie: ch * 10 + si, dense: layer === 0 && sb.orient === 'LL' });
      });
  });
  groups.sort((a, b) => a.key - b.key || a.tie - b.tie);
  let pos = 0;
  for (const g of groups) {
    g.start = pos; g.nb = g.sb.w * g.sb.h; pos += g.nb;
    g.step = cfg.steps[g.layer] * (g.ch ? cfg.chromaW : 1) / W.norms[g.si];
  }
  const posGroup = new Int32Array(pos);
  groups.forEach((g, gi) => posGroup.fill(gi, g.start, g.start + g.nb));
  const denseEnd = groups.filter(g => g.dense).reduce((m, g) => Math.max(m, g.start + g.nb), 0);
  return { groups, total: pos, posGroup, denseEnd };
}

function quantize(ref, layout, cfg, gains) {
  return quantizePlanes(I.rgbToYcc(I.resize(ref, SIZE, SIZE)).map(p => p.data.map(v => v - 128)), layout, cfg, gains);
}

// planes: 3 spatial Float64Array(256*256) (Y, Cb, Cr, zero-centred)
function quantizePlanes(spatial, layout, cfg, gains) {
  const planes = spatial.map(p => W.fwd2d(p));
  const recon = [0, 1, 2].map(() => new Float64Array(SIZE * SIZE)); // reconstruction so far (lower layers)
  const q = new Int32Array(layout.total);
  const off = 0.5 - cfg.dz;
  const byLayer = [...layout.groups].sort((a, b) => a.layer - b.layer);
  for (const g of byLayer) {
    const src = planes[g.ch], rec = recon[g.ch], sb = g.sb;
    for (let y = 0; y < sb.h; y++)
      for (let x = 0; x < sb.w; x++) {
        const idx = (sb.y + y) * SIZE + sb.x + x;
        const resid = src[idx] - rec[idx];
        const c = resid / g.step;
        const v = Math.sign(c) * Math.floor(Math.abs(c) + (g.dense ? 0.5 : off));
        q[g.start + y * sb.w + x] = v;
        rec[idx] += v * g.step;
        if (gains) gains[g.start + y * sb.w + x] = CH_W[g.ch] * (resid * resid - (resid - v * g.step) ** 2);
      }
  }
  return q;
}

// returns 3 zero-centred spatial planes
function reconstructPlanes(q, layout) {
  const coefs = [0, 1, 2].map(() => new Float64Array(SIZE * SIZE));
  for (const g of layout.groups) {
    const dst = coefs[g.ch], sb = g.sb;
    for (let y = 0; y < sb.h; y++)
      for (let x = 0; x < sb.w; x++) {
        const v = q[g.start + y * sb.w + x];
        if (v) dst[(sb.y + y) * SIZE + sb.x + x] += v * g.step;
      }
  }
  return coefs.map(c => W.inv2d(c));
}

function reconstruct(q, layout) {
  const [Y, Cb, Cr] = reconstructPlanes(q, layout).map(p => {
    for (let i = 0; i < p.length; i++) p[i] += 128;
    return { w: SIZE, h: SIZE, c: 1, data: p };
  });
  return I.quantize8(I.yccToRgb(Y, Cb, Cr));
}

const cache = new Map();
function setup(cfg) {
  const key = `${cfg.steps.join(',')}/${cfg.chromaW}/${cfg.chromaDrop}/${cfg.dz}`;
  if (!cache.has(key)) {
    const layout = makeLayout(cfg);
    const tab = PC.train(layout, trainingImages().map(img => quantize(img, layout, cfg)));
    cache.set(key, { layout, tab });
  }
  return cache.get(key);
}

module.exports = {
  name: 'wavl',
  _internal: { makeLayout, quantizePlanes, reconstructPlanes },
  configs(B) {
    const sets = B >= 128 ? [[24, 6], [48, 12], [48, 16, 5]] : B >= 64 ? [[48, 12], [96, 24], [96, 32, 10]] : [[96, 24], [192, 48], [192, 64, 20]];
    const idxMax = B >= 128 ? 10 : 8;
    return sets.map(steps => ({ label: `L${steps.join('-')}`, steps, chromaW: 2, chromaDrop: 1, dz: 0.2, idxMax, adapt: false }));
  },
  encode(ref, cfg, P) {
    const { layout, tab } = setup(cfg);
    const gains = new Float64Array(layout.total);
    const q = quantize(ref, layout, cfg, gains);
    const { runs, spans } = PC.encodeStream(layout, tab, q, P, cfg);
    return { units: W.rdOrder(spans, gains).map(i => runs[i]), baseCount: 0 };
  },
  decoder(cfg, P) {
    const { layout, tab } = setup(cfg);
    const q = new Int32Array(layout.total);
    return {
      stateInfo: `coef textures ${cfg.steps.length} layers x ${SIZE}^2 x 3 (${layout.total} values)`,
      apply(bits) { PC.apply(layout, tab, q, bits, cfg); },
      render() { return reconstruct(q, layout); },
    };
  },
};
