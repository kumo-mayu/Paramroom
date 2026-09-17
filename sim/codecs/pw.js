'use strict';
// PW: additive hybrid = primitive-shape base image + layered wavelet residual.
//
// Packet = [type (1 bit)] + body (P-1 bits)
//   type 0: a PRIM unit (codecs/prim.js format with P-1 bits, few primitives: global structure fast)
//   type 1: a WAVL run (codecs/packet-coder.js format) coding the YCbCr residual ref - primBase
// Render = prim render (from whatever prim units are present) + wavelet residual reconstruction.
// Both parts are idempotent and order independent, so the sum is too. Units of both kinds are merged
// in descending SSE-gain order (prim gains from the greedy fit; residual gains assume the full base).
// Since wavelet residual packets are spatially local runs, RD ordering spends residual bits where the
// primitive base is poor (texture/text) and skips regions the primitives already represent well.
// Shader side: prim decoder state + wavl coefficient textures; output = prim canvas + inverse wavelet.
const fs = require('fs');
const path = require('path');
const I = require('../lib/image');
const PC = require('./packet-coder');
const prim = require('./prim');
const WL = require('./wavl')._internal;
const W = require('./wav')._internal;
const { trainingImages } = require('./training');

const SIZE = 256;

function primCfg(cfg) {
  return prim.cfgOf({ ...cfg.prim, maxPrims: cfg.nPrims });
}

function yccPlanes(img) {
  return I.rgbToYcc(img).map(p => p.data);
}

function primBase(ref, pcfg, P) {
  const enc = prim.encode(ref, pcfg, P);
  const dec = prim.decoder(pcfg, P);
  enc.units.forEach(u => dec.apply(u));
  return { enc, base: dec.render() };
}

function residualPlanes(ref, base) {
  const a = yccPlanes(I.resize(ref, SIZE, SIZE)), b = yccPlanes(base);
  return a.map((p, k) => p.map((v, i) => v - b[k][i]));
}

// Golomb tables trained on residuals of training images (disk-cached: prim fitting is slow).
const tabCache = new Map();
function tables(cfg, layout, P) {
  const key = `${cfg.label}-P${P}`;
  if (tabCache.has(key)) return tabCache.get(key);
  const dir = path.join(__dirname, '..', 'cache');
  const file = path.join(dir, `pw-tab-${key}.json`);
  let tab;
  if (fs.existsSync(file)) tab = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    const pcfg = primCfg(cfg);
    const streams = trainingImages().map(img => {
      const { base } = primBase(img, pcfg, P - 1);
      return WL.quantizePlanes(residualPlanes(img, base), layout, cfg);
    });
    tab = PC.train(layout, streams);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file + '.tmp' + process.pid, JSON.stringify(tab));
    try { fs.renameSync(file + '.tmp' + process.pid, file); } catch (e) { /* another worker won */ }
  }
  tabCache.set(key, tab);
  return tab;
}

function withType(t, bits) { return [t].concat(bits); }

const layoutCache = new Map();
function wLayout(cfg) {
  if (!layoutCache.has(cfg.label)) layoutCache.set(cfg.label, WL.makeLayout(cfg));
  return layoutCache.get(cfg.label);
}

function mk(B, primO, nPrims, steps) {
  const idxMax = B >= 128 ? 10 : 8;
  const label = `n${nPrims}-${prim.cfgOf(primO).label.replace(/-n[^-]*$/, '')}-L${steps.join('-')}`;
  return { label, prim: primO, nPrims, steps, chromaW: 2, chromaDrop: 1, dz: 0.2, idxMax, adapt: false };
}

module.exports = {
  name: 'pw',
  configs(B) {
    if (B >= 256) {
      const p = { shape: 'tri', cb: 7, col: [5, 6, 5], aBits: 2, R: 128 };
      return [mk(B, p, 100, [48, 12]), mk(B, p, 300, [48, 12]), mk(B, p, 300, [48, 16, 5])];
    }
    if (B >= 128) {
      const p = { shape: 'ell', cb: 8, rb: 7, ab: 6, col: [5, 6, 5], aBits: 2, R: 128 };
      return [mk(B, p, 100, [48, 16, 5]), mk(B, p, 300, [48, 16, 5])];
    }
    if (B >= 64) {
      const p = { shape: 'ell', cb: 7, rb: 6, ab: 5, col: [5, 6, 5], aBits: 2, R: 128 };
      return [mk(B, p, 100, [96, 32, 10]), mk(B, p, 250, [96, 32, 10])];
    }
    const p = { shape: 'ell', cb: 6, rb: 5, ab: 4, col: [3, 3, 2], aBits: 2, R: 256 };
    return [mk(B, p, 60, [192, 64, 20]), mk(B, p, 150, [192, 64, 20])];
  },
  encode(ref, cfg, P) {
    const pcfg = primCfg(cfg);
    const layout = wLayout(cfg);
    const tab = tables(cfg, layout, P);
    const { enc, base } = primBase(ref, pcfg, P - 1);
    const gains = new Float64Array(layout.total);
    const q = WL.quantizePlanes(residualPlanes(ref, base), layout, cfg, gains);
    const { runs, spans } = PC.encodeStream(layout, tab, q, P - 1, cfg);
    const pre = new Float64Array(gains.length + 1);
    for (let i = 0; i < gains.length; i++) pre[i + 1] = pre[i] + gains[i];
    const items = [];
    const primScale = (SIZE / pcfg.R) ** 2; // prim gains are SSE on its R x R canvas
    enc.units.forEach((u, i) => items.push({ bits: withType(0, u), gain: enc.gains[i] * primScale, ord: i }));
    // residual gains are in YCbCr-weighted coefficient units; prim gains are RGB SSE (3 channels summed).
    // CH_W weights make the residual gain approximate RGB-SSE per channel => multiply by 3 to compare.
    runs.forEach((r, i) => items.push({ bits: withType(1, r), gain: 3 * (pre[spans[i][1]] - pre[spans[i][0]]), ord: 1e6 + i }));
    items.sort((a, b) => b.gain - a.gain || a.ord - b.ord);
    return { units: items.map(x => x.bits), baseCount: 0 };
  },
  decoder(cfg, P) {
    const pcfg = primCfg(cfg);
    const layout = wLayout(cfg);
    const tab = tables(cfg, layout, P);
    const pdec = prim.decoder(pcfg, P - 1);
    const q = new Int32Array(layout.total);
    let anyPrim = false;
    return {
      stateInfo: `prim(${cfg.nPrims}) + wavl residual (${layout.total} coefs)`,
      apply(bits) {
        if (bits[0] === 0) { pdec.apply(bits.slice(1)); anyPrim = true; }
        else PC.apply(layout, tab, q, bits.slice(1), cfg);
      },
      render() {
        const base = pdec.render(); // grey 128 when no prim unit arrived
        const b = yccPlanes(base);
        const r = WL.reconstructPlanes(q, layout);
        const [Y, Cb, Cr] = [0, 1, 2].map(k => ({ w: SIZE, h: SIZE, c: 1, data: b[k].map((v, i) => v + r[k][i]) }));
        return I.quantize8(I.yccToRgb(Y, Cb, Cr));
      },
    };
  },
};
