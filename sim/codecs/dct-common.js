'use strict';
// Shared layout for progressive DCT codecs.
// Coefficients are organized into "groups" (channel, zigzag band). A static group order (baked into
// the avatar) gives spectral-selection progression: all DC first, then low bands, chroma less often.
// Linear stream position = concatenation of groups in order, blocks in raster order within a group.
const I = require('../lib/image');
const D = require('../lib/dct');

const CHROMA_BANDS = 21;

function makeLayout(cfg) {
  const R = cfg.res;
  const chans = [
    { bw: R / 8, bh: R / 8 },
    { bw: R / 16, bh: R / 16 },
    { bw: R / 16, bh: R / 16 },
  ];
  const groups = [];
  for (let k = 0; k < 64; k++) groups.push({ ch: 0, k, key: k, tie: 0 });
  for (let ch = 1; ch <= 2; ch++)
    for (let k = 0; k < CHROMA_BANDS; k++) groups.push({ ch, k, key: 2 * k + 0.5, tie: ch });
  groups.sort((a, b) => a.key - b.key || a.tie - b.tie);
  let pos = 0;
  for (const g of groups) {
    const qt = g.ch === 0 ? D.QY : D.QC;
    g.step = qt[D.ZIGZAG[g.k]] * cfg.scale;
    g.nb = chans[g.ch].bw * chans[g.ch].bh;
    g.start = pos;
    pos += g.nb;
  }
  const total = pos;
  // position -> group index lookup
  const posGroup = new Int32Array(total);
  groups.forEach((g, gi) => posGroup.fill(gi, g.start, g.start + g.nb));
  const dcEnd = groups.findIndex(g => g.k !== 0);
  return { R, chans, groups, total, posGroup, dcEndPos: groups[dcEnd].start };
}

// Quantized coefficient stream (Int32Array, length layout.total) for a reference image.
function quantizeImage(ref, layout) {
  const R = layout.R;
  const [Y, Cb, Cr] = I.rgbToYcc(I.resize(ref, R, R));
  const planes = [Y, I.resize(Cb, R / 2, R / 2), I.resize(Cr, R / 2, R / 2)].map(D.planeToCoefs);
  const q = new Int32Array(layout.total);
  for (const g of layout.groups) {
    const { coefs } = planes[g.ch];
    const raster = D.ZIGZAG[g.k];
    for (let b = 0; b < g.nb; b++) q[g.start + b] = Math.round(coefs[b * 64 + raster] / g.step);
  }
  return q;
}

// Reconstruct a 256x256 RGB image from a quantized stream state.
function reconstruct(q, layout) {
  const planes = layout.chans.map(c => ({ ...c, coefs: new Float64Array(c.bw * c.bh * 64) }));
  for (const g of layout.groups) {
    const p = planes[g.ch], raster = D.ZIGZAG[g.k];
    for (let b = 0; b < g.nb; b++) {
      const v = q[g.start + b];
      if (v) p.coefs[b * 64 + raster] = v * g.step;
    }
  }
  const [Y, Cb, Cr] = planes.map(p => D.coefsToPlane(p.bw, p.bh, p.coefs));
  const R = layout.R;
  const rgb = I.yccToRgb(Y, I.resizeBilinear(Cb, R, R), I.resizeBilinear(Cr, R, R));
  return I.quantize8(I.resize(I.clamp255(rgb), 256, 256));
}

module.exports = { makeLayout, quantizeImage, reconstruct };
