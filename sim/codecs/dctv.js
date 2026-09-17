'use strict';
// DCTV: progressive block DCT (8x8, YCbCr 4:2:0) with self-contained variable-length packets.
// Static group order (spectral selection: all DC, then low bands; chroma bands at half rate).
// Packet format: see packet-coder.js. DC groups are "dense" (DPCM), AC groups "sparse" (run/level).
const C = require('./dct-common');
const PC = require('./packet-coder');
const { trainingImages } = require('./training');

const cache = new Map();
function setup(cfg) {
  const key = `${cfg.res}/${cfg.scale}`;
  if (!cache.has(key)) {
    const layout = C.makeLayout(cfg);
    layout.denseEnd = layout.dcEndPos;
    const tab = PC.train(layout, trainingImages().map(img => C.quantizeImage(img, layout)));
    cache.set(key, { layout, tab });
  }
  return cache.get(key);
}

module.exports = {
  name: 'dctv',
  configs(B) {
    const out = [];
    const scales = B >= 128 ? [1, 2, 4] : [2, 4, 8];
    for (const res of [128, 256]) for (const scale of scales) out.push({ label: `r${res}-s${scale}`, res, scale });
    return out;
  },
  encode(ref, cfg, P) {
    const { layout, tab } = setup(cfg);
    return PC.encode(layout, tab, C.quantizeImage(ref, layout), P);
  },
  decoder(cfg, P) {
    const { layout, tab } = setup(cfg);
    const q = new Int32Array(layout.total);
    return {
      stateInfo: `coef texture ${layout.total}`,
      apply(bits) { PC.apply(layout, tab, q, bits); },
      render() { return C.reconstruct(q, layout); },
    };
  },
};
