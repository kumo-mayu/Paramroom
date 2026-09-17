'use strict';
// DUAL: two-stream composition = short-cycle THUMBNAIL stream + long-cycle DETAIL stream.
// (Motivated by the analysis of vFeez/VRChat-OSC-Video: re-sending a whole tiny image every ~1-4 s gives
//  every viewer, including late joiners and viewers who lost packets, a coarse picture within seconds.)
//
// Packet = [stream (1 bit)] + body (P-1 bits)
//   stream 0: THUMBNAIL unit = codecs/raw.js unit (tiny RGB grid, fixed-width values, short unit id)
//   stream 1: DETAIL unit, coding the residual  ref - thumbnailBase  (thumbnailBase = bilinear raw render):
//     detail 'wavl': packet-coder run of a layered wavelet residual (P-1 bits)
//     detail 'pw'  : [kind (1 bit)] prim unit (primitives drawn over the thumbnail) | wavl run on the rest
// Render = thumbnail base (grey where not yet known) [+ primitives] + wavelet residual.
// Schedule (transport 'dual'): every `period`-th slot sends the next thumbnail unit (cyclic), the other slots
// run the detail carousel in gain order. All writes are idempotent/order independent.
// Shader side: raw latch texels + (prim state) + wavl coefficient textures; output = sum.
const fs = require('fs');
const path = require('path');
const I = require('../lib/image');
const PC = require('./packet-coder');
const raw = require('./raw');
const prim = require('./prim');
const WL = require('./wavl')._internal;
const { trainingImages } = require('./training');

const SIZE = 256;
const ycc = img => I.rgbToYcc(img).map(p => p.data);

function thumbCfg(cfg) {
  const t = cfg.thumb;
  return { label: `g${t.g}-b${t.bits}-${t.order}${t.order === 'rows' ? t.F : ''}`, F: 2, ...t };
}
function primCfg(cfg) { return prim.cfgOf({ ...cfg.prim, maxPrims: cfg.nPrims }); }

function thumbBase(ref, tcfg, P) {
  const e = raw.encode(ref, tcfg, P);
  const d = raw.decoder(tcfg, P);
  e.units.forEach(u => d.apply(u));
  return { units: e.units, base: d.render() };
}

// Base image (thumbnail [+ primitives]) and the units that build it.
function buildBase(ref, cfg, P) {
  const tcfg = thumbCfg(cfg);
  const th = thumbBase(ref, tcfg, P - 1);
  if (cfg.detail !== 'pw') return { th, base: th.base };
  const pcfg = primCfg(cfg);
  const pe = prim.encode(ref, pcfg, P - 2, th.base);
  const pd = prim.decoder(pcfg, P - 2);
  pe.units.forEach(u => pd.apply(u));
  return { th, pe, pcfg, base: pd.render(th.base) };
}

function residual(ref, base) {
  const a = ycc(I.resize(ref, SIZE, SIZE)), b = ycc(base);
  return a.map((p, k) => p.map((v, i) => v - b[k][i]));
}

const tabCache = new Map();
function tables(cfg, layout, P) {
  const key = `dual-${cfg.label}-P${P}`;
  if (tabCache.has(key)) return tabCache.get(key);
  const dir = path.join(__dirname, '..', 'cache');
  const file = path.join(dir, `${key}.json`);
  let tab;
  if (fs.existsSync(file)) tab = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    tab = PC.train(layout, trainingImages().map(img => WL.quantizePlanes(residual(img, buildBase(img, cfg, P).base), layout, cfg)));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(tab));
    try { fs.renameSync(tmp, file); } catch (e) { /* another worker won */ }
  }
  tabCache.set(key, tab);
  return tab;
}

const layoutCache = new Map();
function wLayout(cfg) {
  if (!layoutCache.has(cfg.label)) layoutCache.set(cfg.label, WL.makeLayout(cfg));
  return layoutCache.get(cfg.label);
}

function mk(B, o) {
  const t = o.thumb;
  const th = `th${t.g}b${t.bits}${t.order === 'rows' ? 'r' : 'l'}`;
  const det = o.detail === 'pw' ? `pw${o.nPrims}` : 'wavl';
  const label = `${th}-k${o.period}-${det}-L${o.steps.join('-')}`;
  return { label, chromaW: 2, chromaDrop: 1, dz: 0.2, idxMax: B >= 128 ? 10 : 8, adapt: false, ...o };
}

module.exports = {
  name: 'dual',
  configs(B) {
    const out = [];
    if (B >= 128) {
      const steps = B >= 256 ? [48, 12] : [48, 16, 5];
      const pr = B >= 256 ? { shape: 'tri', cb: 7, col: [5, 6, 5], aBits: 2, R: 128 } : { shape: 'ell', cb: 8, rb: 7, ab: 6, col: [5, 6, 5], aBits: 2, R: 128 };
      for (const period of [4, 8]) {
        out.push(mk(B, { thumb: { g: 16, bits: 2, order: 'rows', F: 2 }, period, detail: 'wavl', steps }));
        out.push(mk(B, { thumb: { g: 16, bits: 2, order: 'rows', F: 2 }, period, detail: 'pw', nPrims: 100, prim: pr, steps }));
      }
      out.push(mk(B, { thumb: { g: 16, bits: 3, order: 'lattice' }, period: 4, detail: 'pw', nPrims: 100, prim: pr, steps }));
    } else if (B >= 64) {
      const steps = [96, 32, 10];
      const pr = { shape: 'ell', cb: 7, rb: 6, ab: 5, col: [5, 6, 5], aBits: 2, R: 128 };
      for (const period of [4, 8]) {
        out.push(mk(B, { thumb: { g: 8, bits: 3, order: 'lattice' }, period, detail: 'wavl', steps }));
        out.push(mk(B, { thumb: { g: 8, bits: 3, order: 'lattice' }, period, detail: 'pw', nPrims: 100, prim: pr, steps }));
      }
      out.push(mk(B, { thumb: { g: 16, bits: 2, order: 'rows', F: 2 }, period: 4, detail: 'pw', nPrims: 100, prim: pr, steps }));
    } else {
      const steps = [192, 64, 20];
      const pr = { shape: 'ell', cb: 6, rb: 5, ab: 4, col: [3, 3, 2], aBits: 2, R: 256 };
      for (const period of [4, 8]) {
        out.push(mk(B, { thumb: { g: 8, bits: 2, order: 'lattice' }, period, detail: 'wavl', steps }));
        out.push(mk(B, { thumb: { g: 8, bits: 2, order: 'lattice' }, period, detail: 'pw', nPrims: 60, prim: pr, steps }));
      }
    }
    return out;
  },
  encode(ref, cfg, P) {
    const layout = wLayout(cfg);
    const detailP = cfg.detail === 'pw' ? P - 2 : P - 1;
    const tab = tables(cfg, layout, P);
    const b = buildBase(ref, cfg, P);
    const gains = new Float64Array(layout.total);
    const q = WL.quantizePlanes(residual(ref, b.base), layout, cfg, gains);
    const { runs, spans } = PC.encodeStream(layout, tab, q, detailP, cfg);
    const pre = new Float64Array(gains.length + 1);
    for (let i = 0; i < gains.length; i++) pre[i + 1] = pre[i] + gains[i];
    const items = [];
    const wPrefix = cfg.detail === 'pw' ? [1, 1] : [1];
    runs.forEach((r, i) => items.push({ bits: wPrefix.concat(r), gain: 3 * (pre[spans[i][1]] - pre[spans[i][0]]), ord: 1e6 + i }));
    if (cfg.detail === 'pw') {
      const scale = (SIZE / b.pcfg.R) ** 2;
      b.pe.units.forEach((u, i) => items.push({ bits: [1, 0].concat(u), gain: (i === 0 ? 1e30 : b.pe.gains[i] * scale), ord: i }));
    }
    items.sort((x, y) => y.gain - x.gain || x.ord - y.ord);
    const thumbs = b.th.units.map(u => [0].concat(u));
    return { units: thumbs.concat(items.map(x => x.bits)), baseCount: thumbs.length, schedule: { type: 'dual', period: cfg.period } };
  },
  decoder(cfg, P) {
    const layout = wLayout(cfg);
    const tab = tables(cfg, layout, P);
    const tcfg = thumbCfg(cfg);
    const td = raw.decoder(tcfg, P - 1);
    const pcfg = cfg.detail === 'pw' ? primCfg(cfg) : null;
    const pd = pcfg ? prim.decoder(pcfg, P - 2) : null;
    const q = new Int32Array(layout.total);
    return {
      stateInfo: `thumb ${tcfg.label} + ${cfg.detail} residual`,
      apply(bits) {
        if (bits[0] === 0) td.apply(bits.slice(1));
        else if (cfg.detail === 'pw') {
          if (bits[1] === 0) pd.apply(bits.slice(2));
          else PC.apply(layout, tab, q, bits.slice(2), cfg);
        } else PC.apply(layout, tab, q, bits.slice(1), cfg);
      },
      render() {
        let base = td.render(); // mid grey where unknown
        if (pd) base = pd.render(base);
        const bp = ycc(base), r = WL.reconstructPlanes(q, layout);
        const [Y, Cb, Cr] = [0, 1, 2].map(k => ({ w: SIZE, h: SIZE, c: 1, data: bp[k].map((v, i) => v + r[k][i]) }));
        return I.quantize8(I.yccToRgb(Y, Cb, Cr));
      },
    };
  },
};
