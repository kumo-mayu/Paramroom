'use strict';
// DCTF: progressive DCT with fixed-length fields and implicit addressing.
//
// Static (baked) tables: per-group bit width. DC widths cover the full analytic range (no clipping);
// AC widths cover 99.9% of quantized training values (larger values are clipped). The stream is packed into units of whole
// values in static group order; unit id (u bits) -> value range is a static table.
// Packet = [unit id (u bits)] [fixed-width signed values...]. Simplest possible shader parsing.
const { BitWriter, BitReader } = require('../lib/bits');
const C = require('./dct-common');
const { trainingImages } = require('./training');

const widthCache = new Map();
function widths(cfg, layout) {
  const key = `${cfg.res}/${cfg.scale}`;
  if (widthCache.has(key)) return widthCache.get(key);
  const samples = layout.groups.map(() => []);
  for (const img of trainingImages()) {
    const q = C.quantizeImage(img, layout);
    layout.groups.forEach((g, gi) => { for (let b = 0; b < g.nb; b++) samples[gi].push(Math.abs(q[g.start + b])); });
  }
  const w = samples.map((s, gi) => {
    const g = layout.groups[gi];
    if (g.k === 0) return Math.ceil(Math.log2(Math.ceil(1024 / g.step) + 1)) + 1; // DC = 8*mean, |DC| <= 1024
    s.sort((a, b) => a - b);
    const m = s[Math.floor(s.length * 0.999)];
    return m === 0 ? 0 : Math.ceil(Math.log2(m + 1)) + 1; // signed
  });
  widthCache.set(key, w);
  return w;
}

// Static packing: returns {u, units: [{start, entries: [[pos, width]...]}]}
const layoutCache = new Map();
function packing(cfg, P) {
  const key = `${cfg.res}/${cfg.scale}/${P}`;
  if (layoutCache.has(key)) return layoutCache.get(key);
  const layout = C.makeLayout(cfg);
  const w = widths(cfg, layout);
  const seq = [];
  layout.groups.forEach((g, gi) => { if (w[gi]) for (let b = 0; b < g.nb; b++) seq.push([g.start + b, w[gi]]); });
  for (let u = 1; u < 20; u++) {
    const cap = P - u;
    const units = [];
    let cur = [], used = 0;
    for (const e of seq) {
      if (used + e[1] > cap) { units.push(cur); cur = []; used = 0; }
      cur.push(e); used += e[1];
    }
    if (cur.length) units.push(cur);
    if (units.length <= (1 << u)) {
      const res = { u, units, layout, w };
      layoutCache.set(key, res);
      return res;
    }
  }
  throw new Error('packing failed');
}

module.exports = {
  name: 'dctf',
  configs(B) {
    const out = [];
    const scales = B >= 128 ? [1, 2, 4] : [2, 4, 8];
    for (const res of [128, 256]) for (const scale of scales) out.push({ label: `r${res}-s${scale}`, res, scale });
    return out;
  },
  encode(ref, cfg, P) {
    const pk = packing(cfg, P);
    const q = C.quantizeImage(ref, pk.layout);
    let baseCount = 0;
    const units = pk.units.map((entries, id) => {
      const wr = new BitWriter();
      wr.write(id, pk.u);
      for (const [pos, width] of entries) {
        const lim = (1 << (width - 1)) - 1;
        wr.writeSigned(Math.max(-lim - 1, Math.min(lim, q[pos])), width);
      }
      if (entries[0][0] < pk.layout.dcEndPos) baseCount = id + 1;
      return wr.bits;
    });
    return { units, baseCount };
  },
  decoder(cfg, P) {
    const pk = packing(cfg, P);
    const q = new Int32Array(pk.layout.total);
    return {
      stateInfo: `coef texture ${pk.layout.total}`,
      apply(bits) {
        const r = new BitReader(bits);
        const id = r.read(pk.u);
        if (id >= pk.units.length) return;
        for (const [pos, width] of pk.units[id]) q[pos] = r.readSigned(width);
      },
      render() { return C.reconstruct(q, pk.layout); },
    };
  },
};
