'use strict';
// PRIMX: experimental variants of the PRIM codec (sim/codecs/prim.js), for docs/research/07.
// Difference: cfg.soft = [[q, w], ...] draws a primitive with a stepped edge (weight w where the squared ellipse distance
// is <= q; the list must be ascending in q, descending in w). Without cfg.soft this is bit-identical to prim.
// Everything else (fields, packing, layout, greedy search) is the same, so the two can be compared at equal bits.
//
// The image is approximated offline by a greedy sequence of alpha-blended primitives (rotated
// ellipses, triangles or axis-aligned rectangles) over a flat background colour. Primitives are
// sent in greedy order, so any prefix is a usable image (progressive).
//
// Packet format (all fields fixed width, MSB first; static per (cfg, P)):
//   every unit:   [unit id (u bits)] payload (P-u bits)
//   primitive:    geometry codes | colour R,G,B (cr,cg,cb bits) | alpha (aBits; 0 => fixed cfg.alpha)
//     tri : x0 y0 x1 y1 x2 y2            (each cb bits, x = q/(2^cb-1)*R)
//     ell : cx cy (cb) rx ry (rb) theta (ab bits, theta = q/2^ab*pi, r = R/2*((q+1)/2^rb)^2, >=0.5px)
//     rect: x0 y0 x1 y1                  (each cb bits)
//   alpha = (q+1)/2^aBits
//   Mode s=1 (primitive fits one unit): unit 0 = [id][bg RGB565 (16)][k0 primitives],
//            unit i>=1 = [id][k primitives] -> primitive index is static from (id, slot).
//   Mode s=2 (primitive needs 2 units): unit 0 = [id][bg RGB565]; primitive j is split over
//            unit ids 1+2j (first P-u bits) and 2+2j (rest); it renders only when both are present.
// Decoder state: raw payload per unit id (on GPU: decoded primitive parameters in texels).
// apply() just overwrites the slot for its id -> idempotent and order independent.
// Render: canvas = bg (or grey 128 if unit 0 missing) at R x R, then for every primitive in index
// order whose units are present: per-pixel analytic coverage test at the pixel centre (edge
// functions / rotated ellipse quadratic / box), hard edges, c = c*(1-a) + col*a; resize to 256.
// Shader cost: per output texel a loop over all N stored primitives (N = 200..5000 depending on
// cfg) => N x R^2 coverage tests + blends per full redraw (N=1000, R=256: 66M; N=5000, R=256:
// 330M). A redraw is only needed when the state changes (can be spread / tiled over frames).
// Encoder: greedy; per primitive ~200 error-weighted random candidates, hill climbing of the best 4
// on quantized codes (on 2x2-subsampled pixels when R=256), then a full-resolution polish. Colour
// and alpha are solved in closed form from per-shape pixel sums and quantized (exact SSE delta).
const { BitReader } = require('../lib/bits');
const I = require('../lib/image');
const T = require('../lib/transport');

// ---------------------------------------------------------------------------------------------
// Static layout
function geomWidths(cfg) {
  if (cfg.shape === 'tri') return [cfg.cb, cfg.cb, cfg.cb, cfg.cb, cfg.cb, cfg.cb];
  if (cfg.shape === 'ell') return cfg.circle ? [cfg.cb, cfg.cb, cfg.rb] : [cfg.cb, cfg.cb, cfg.rb, cfg.rb, cfg.ab];
  if (cfg.shape === 'rect') return [cfg.cb, cfg.cb, cfg.cb, cfg.cb];
  throw new Error('shape ' + cfg.shape);
}

const layoutCache = new Map();
function layout(cfg, P) {
  const key = cfg.label + '/' + P;
  if (layoutCache.has(key)) return layoutCache.get(key);
  const gw = geomWidths(cfg);
  const cw = cfg.col; // [r,g,b] bits
  const widths = gw.concat(cw, cfg.aBits ? [cfg.aBits] : []);
  const primBits = widths.reduce((a, b) => a + b, 0);
  let L = null;
  for (let u = 1; u <= 16 && !L; u++) {
    const pay = P - u;
    let s, k = 0, k0 = 0, units, maxPrims = cfg.maxPrims;
    if (primBits <= pay) {
      s = 1; k = Math.floor(pay / primBits); k0 = Math.max(0, Math.floor((pay - 16) / primBits));
      maxPrims = k0 + Math.ceil(Math.max(0, cfg.maxPrims - k0) / k) * k;
      units = 1 + (maxPrims - k0) / k;
    } else if (primBits <= 2 * pay) {
      s = 2; units = 1 + 2 * maxPrims;
    } else continue;
    if (units <= (1 << u)) L = { u, pay, s, k, k0, units, maxPrims, primBits, widths, ng: gw.length };
  }
  if (!L) throw new Error(`prim: cannot fit ${primBits}-bit primitive into P=${P}`);
  layoutCache.set(key, L);
  return L;
}

// unit id and bit offset (within payload) of primitive j (s=1)
function primLoc(L, j) {
  if (j < L.k0) return [0, 16 + j * L.primBits];
  const r = j - L.k0;
  return [1 + Math.floor(r / L.k), (r % L.k) * L.primBits];
}

// ---------------------------------------------------------------------------------------------
// Geometry & coverage (shared by encoder and decoder so both see identical pixels)
function makeGeom(cfg) {
  const R = cfg.R, shape = cfg.shape, soft = cfg.soft || null;
  const cmax = (1 << cfg.cb) - 1;
  const rN = 1 << (cfg.rb || 1), aN = 1 << (cfg.ab || 1);
  // codes -> float params in canvas pixel units, into g
  function geom(codes, g) {
    if (shape === 'ell') {
      g[0] = codes[0] / cmax * R; g[1] = codes[1] / cmax * R;
      g[2] = Math.max(0.5, R / 2 * ((codes[2] + 1) / rN) ** 2);
      // cfg.circle: no second radius and no angle (the 14 bits they cost buy more primitives instead)
      g[3] = cfg.circle ? g[2] : Math.max(0.5, R / 2 * ((codes[3] + 1) / rN) ** 2);
      g[4] = cfg.circle ? 0 : codes[4] / aN * Math.PI;
    } else {
      for (let i = 0; i < codes.length; i++) g[i] = codes[i] / cmax * R;
    }
  }
  // fills idx with covered pixel indices (and wOut with the weight of each, when given), returns the count
  function raster(g, idx, st = 1, wOut = null) {
    let n = 0;
    if (shape === 'tri') {
      const x0 = g[0], y0 = g[1], x1 = g[2], y1 = g[3], x2 = g[4], y2 = g[5];
      const bx0 = Math.max(0, Math.floor(Math.min(x0, x1, x2) - 0.5)), bx1 = Math.min(R - 1, Math.ceil(Math.max(x0, x1, x2)));
      const by0 = Math.max(0, Math.floor(Math.min(y0, y1, y2) - 0.5)), by1 = Math.min(R - 1, Math.ceil(Math.max(y0, y1, y2)));
      const ax = x1 - x0, ay = y1 - y0, bx = x2 - x1, by = y2 - y1, cx = x0 - x2, cy = y0 - y2;
      for (let y = by0 + (st - by0 % st) % st; y <= by1; y += st) {
        const py = y + 0.5, row = y * R;
        const e0y = ax * (py - y0), e1y = bx * (py - y1), e2y = cx * (py - y2);
        for (let x = bx0 + (st - bx0 % st) % st; x <= bx1; x += st) {
          const px = x + 0.5;
          const w0 = e0y - ay * (px - x0), w1 = e1y - by * (px - x1), w2 = e2y - cy * (px - x2);
          if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) idx[n++] = row + x;
        }
      }
    } else if (shape === 'ell') {
      const cx = g[0], cy = g[1], rx = g[2], ry = g[3], c = Math.cos(g[4]), s = Math.sin(g[4]);
      const qMax = soft ? soft[soft.length - 1][0] : 1, ext = Math.sqrt(qMax);
      const ex = ext * Math.sqrt(rx * rx * c * c + ry * ry * s * s), ey = ext * Math.sqrt(rx * rx * s * s + ry * ry * c * c);
      const bx0 = Math.max(0, Math.floor(cx - ex - 0.5)), bx1 = Math.min(R - 1, Math.ceil(cx + ex));
      const by0 = Math.max(0, Math.floor(cy - ey - 0.5)), by1 = Math.min(R - 1, Math.ceil(cy + ey));
      const irx = 1 / (rx * rx), iry = 1 / (ry * ry);
      for (let y = by0 + (st - by0 % st) % st; y <= by1; y += st) {
        const dy = y + 0.5 - cy, row = y * R;
        for (let x = bx0 + (st - bx0 % st) % st; x <= bx1; x += st) {
          const dx = x + 0.5 - cx;
          const u = dx * c + dy * s, v = dy * c - dx * s;
          const q = u * u * irx + v * v * iry;
          if (q > qMax) continue;
          if (wOut) { let w = 0; for (let t = 0; t < soft.length; t++) if (q <= soft[t][0]) { w = soft[t][1]; break; } wOut[n] = w; }
          idx[n++] = row + x;
        }
      }
    } else {
      const xa = Math.min(g[0], g[2]), xb = Math.max(g[0], g[2]), ya = Math.min(g[1], g[3]), yb = Math.max(g[1], g[3]);
      const bx0 = Math.max(0, Math.ceil(xa - 0.5)), bx1 = Math.min(R - 1, Math.floor(xb - 0.5));
      const by0 = Math.max(0, Math.ceil(ya - 0.5)), by1 = Math.min(R - 1, Math.floor(yb - 0.5));
      for (let y = by0 + (st - by0 % st) % st; y <= by1; y += st) for (let x = bx0 + (st - bx0 % st) % st; x <= bx1; x += st) idx[n++] = y * R + x;
    }
    return n;
  }
  return { geom, raster };
}

const colVal = (q, b) => q * 255 / ((1 << b) - 1);
// cfg.blend = 'add': a primitive adds (signed colour x kernel weight) to the canvas instead of blending over it, so the
// result does not depend on the order the primitives are drawn in (GaussianImage's "accumulated blending"). The code is
// signed and square-law: fine steps near 0 (most splats are small corrections), coarse at the extremes.
const addVal = (q, b, vmax) => { const c = ((1 << b) - 1) / 2, t = (q - c) / c; return Math.sign(t) * t * t * vmax; };
const addCode = (v, b, vmax) => {
  const c = ((1 << b) - 1) / 2, t = Math.sign(v) * Math.sqrt(Math.min(1, Math.abs(v) / vmax));
  return Math.max(0, Math.min((1 << b) - 1, Math.round(t * c + c)));
};
const alphaVal = (cfg, q) => cfg.aBits ? (q + 1) / (1 << cfg.aBits) : cfg.alpha;
function bg565(c) {
  const q = [Math.round(c[0] / 255 * 31), Math.round(c[1] / 255 * 63), Math.round(c[2] / 255 * 31)];
  return { code: (q[0] << 11) | (q[1] << 5) | q[2], rgb: [q[0] * 255 / 31, q[1] * 255 / 63, q[2] * 255 / 31] };
}
function from565(v) { return [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31]; }

function blend(cur, idx, n, rgb, a, w = null) {
  for (let i = 0; i < n; i++) {
    const o = idx[i] * 3, k = w ? a * w[i] : a, ia = 1 - k;
    cur[o] = cur[o] * ia + rgb[0] * k; cur[o + 1] = cur[o + 1] * ia + rgb[1] * k; cur[o + 2] = cur[o + 2] * ia + rgb[2] * k;
  }
}

function blendAdd(cur, idx, n, rgb, w = null) {
  for (let i = 0; i < n; i++) {
    const o = idx[i] * 3, k = w ? w[i] : 1;
    cur[o] += rgb[0] * k; cur[o + 1] += rgb[1] * k; cur[o + 2] += rgb[2] * k;
  }
}

// ---------------------------------------------------------------------------------------------
// Configs
function cfgOf(o) {
  const col = o.col || [5, 6, 5];
  const geo = o.shape === 'ell' ? `e${o.cb}.${o.rb}.${o.ab}` : o.shape === 'tri' ? `t${o.cb}` : `q${o.cb}`;
  const soft = (o.soft ? '-s' + o.soft.map(([q, w]) => `${q}:${w}`).join('_') : '') + (o.circle ? '-circ' : '') + (o.blend === 'add' ? '-add' : '');
  const label = `${geo}-c${col.join('')}a${o.aBits || 0}-r${o.R}-n${o.maxPrims}${soft}`;
  return { alpha: 0.5, ...o, col, label };
}

// ---------------------------------------------------------------------------------------------
// Aspect ratio metadata (wire level, outside the codec units): the image is stretched to the square
// R x R canvas and the display un-stretches it. The code rides in the last 8 bits of every packet
// (unused padding when spareBits(L) >= 8), so it arrives with the first packet of any unit.
//   code 0 = unknown (treated as 1:1, what older senders send), 1..255: log2(w/h) = (code-1)/254*4-2
//   (w/h in [1/4, 4], ratio step 1.1 %, error <= 0.55 %; 1:1 = 128, 16:9 = 181, 3:2 = 165, 9:16 = 75).
function aspectCode(w, h) {
  const l = Math.max(-2, Math.min(2, Math.log2(w / h)));
  return 1 + Math.round((l + 2) / 4 * 254);
}
function aspectRatio(code) { return code === 0 ? 1 : 2 ** ((code - 1) / 254 * 4 - 2); }
// unused trailing payload bits of every unit (s=1 layouts)
function spareBits(L) { return L.s === 1 ? L.pay - Math.max(16 + L.k0 * L.primBits, L.k * L.primBits) : 0; }

module.exports = {
  name: 'primx',
  layout,
  cfgOf,
  aspectCode,
  aspectRatio,
  spareBits,
  configs(B) {
    const c = [];
    const add = o => c.push(cfgOf(o));
    if (B >= 256) { // P=254: 4 primitives/unit (tri 60 bits, ell 58 bits)
      add({ shape: 'tri', cb: 7, col: [5, 6, 5], aBits: 2, R: 256, maxPrims: 1000 });
      add({ shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, R: 256, maxPrims: 1000 });
      add({ shape: 'tri', cb: 7, col: [5, 6, 5], aBits: 2, R: 256, maxPrims: 5000 });
      add({ shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, R: 256, maxPrims: 5000 });
      add({ shape: 'tri', cb: 7, col: [5, 6, 5], aBits: 2, R: 128, maxPrims: 1000 });
    } else if (B >= 128) { // P=126: 2 primitives/unit (56 / 54 bits)
      add({ shape: 'tri', cb: 7, col: [4, 4, 4], aBits: 2, R: 256, maxPrims: 1000 });
      add({ shape: 'ell', cb: 8, rb: 7, ab: 6, col: [5, 6, 5], aBits: 2, R: 256, maxPrims: 1000 });
      add({ shape: 'tri', cb: 7, col: [4, 4, 4], aBits: 2, R: 256, maxPrims: 2500 });
      add({ shape: 'ell', cb: 8, rb: 7, ab: 6, col: [5, 6, 5], aBits: 2, R: 256, maxPrims: 2500 });
      add({ shape: 'ell', cb: 8, rb: 7, ab: 6, col: [5, 6, 5], aBits: 2, R: 128, maxPrims: 1000 });
    } else if (B >= 64) { // P=62: 1 primitive/unit (u=9..11 -> 51..53 bits)
      add({ shape: 'tri', cb: 7, col: [3, 3, 2], aBits: 1, R: 256, maxPrims: 1280 });
      add({ shape: 'ell', cb: 8, rb: 7, ab: 5, col: [4, 4, 4], aBits: 2, R: 256, maxPrims: 1280 });
      add({ shape: 'rect', cb: 8, col: [5, 6, 5], aBits: 2, R: 256, maxPrims: 1280 });
      add({ shape: 'ell', cb: 8, rb: 7, ab: 5, col: [4, 4, 4], aBits: 2, R: 256, maxPrims: 400 });
      add({ shape: 'ell', cb: 7, rb: 6, ab: 5, col: [5, 6, 5], aBits: 2, R: 128, maxPrims: 400 });
    } else { // P=30
      // split over 2 units (u=9..11 -> 38..42 bits per primitive)
      add({ shape: 'ell', cb: 6, rb: 5, ab: 4, col: [3, 3, 2], aBits: 2, R: 256, maxPrims: 640 });
      add({ shape: 'tri', cb: 5, col: [3, 3, 2], aBits: 0, R: 256, maxPrims: 640 });
      add({ shape: 'ell', cb: 6, rb: 5, ab: 4, col: [3, 3, 2], aBits: 2, R: 256, maxPrims: 200 });
      // reduced precision, one unit each (u=8 -> 22 bits), loss of one unit loses one primitive only
      add({ shape: 'ell', cb: 4, rb: 3, ab: 2, col: [2, 2, 2], aBits: 0, R: 64, maxPrims: 250 });
    }
    return c;
  },

  // base (optional): RGB image used as the initial canvas instead of the background colour (hybrid codecs)
  encode(ref, cfg, P, base) {
    const L = layout(cfg, P);
    const R = cfg.R, NP = R * R;
    const G = makeGeom(cfg);
    const tgt = Float64Array.from(I.resize(ref, R, R).data);
    const cur = new Float64Array(NP * 3);
    const rnd = T.mulberry32(cfg.seed || 0x5eed);
    const ng = L.ng, gw = L.widths.slice(0, ng), gmax = gw.map(b => (1 << b) - 1);
    const [crb, cgb, cbb] = cfg.col;
    const cLv = cfg.col.map(b => (1 << b) - 1);
    const add = cfg.blend === 'add';
    const vmax = cfg.vmax || 255;
    const nAlpha = cfg.aBits ? 1 << cfg.aBits : 1;
    const alphas = Array.from({ length: nAlpha }, (_, q) => alphaVal(cfg, q));

    // background: quantized mean
    const mean = [0, 0, 0];
    for (let i = 0; i < NP * 3; i++) mean[i % 3] += tgt[i] / NP;
    const bg = bg565(mean);
    if (base) cur.set(I.resize(base, R, R).data); else for (let i = 0; i < NP * 3; i++) cur[i] = bg.rgb[i % 3];

    const idx = new Int32Array(NP);
    const wBuf = cfg.soft ? new Float64Array(NP) : null;
    const g = new Float64Array(6);
    const S = new Float64Array(15);
    // Search stride: for large canvases, candidates are scored on every st-th pixel (st x st
    // subsampling; small shapes fall back to full sampling); the winner is re-scored and polished at
    // stride 1, so emitted colour/alpha codes are always exact for the decoder's raster.
    const searchSt = cfg.searchSt || (R >= 256 ? 2 : 1);

    // error delta (new SSE - old SSE) of a shape with optimal quantized colour/alpha
    function evaluate(codes, out, st = 1) {
      G.geom(codes, g);
      let n = G.raster(g, idx, st, wBuf);
      if (st > 1 && n < 64) { st = 1; n = G.raster(g, idx, 1, wBuf); }
      if (n === 0) { out[0] = 0; out[1] = out[2] = out[3] = 0; return 0; }
      return (add ? scoreSumsAdd(n, out) : scoreSums(n, out)) * st * st;
    }
    // Sums with the per-pixel coverage weight w (1 for a hard edge). With k = alpha * w the change in squared error of
    // painting colour v is  -2 v (a S1) + 2 (a S2) + v^2 (a^2 S3) - 2 v (a^2 S4) + (a^2 S5),
    // where S1 = sum w d, S2 = sum w d c, S3 = sum w^2, S4 = sum w^2 c, S5 = sum w^2 c^2 (d = target - canvas).
    // Additive: painting v (signed) changes the squared error by -2 v (sum w e) + v^2 (sum w^2); the best v is
    // (sum w e) / (sum w^2), which is then quantized on the signed square-law grid.
    function scoreSumsAdd(n, out) {
      S.fill(0);
      let Sw2 = 0;
      for (let i = 0; i < n; i++) {
        const o = idx[i] * 3, w = wBuf ? wBuf[i] : 1;
        Sw2 += w * w;
        for (let ch = 0; ch < 3; ch++) S[ch] += w * (tgt[o + ch] - cur[o + ch]);
      }
      if (Sw2 <= 0) { out[0] = out[1] = out[2] = out[3] = 0; return 0; }
      let tot = 0;
      out[0] = 0;
      for (let ch = 0; ch < 3; ch++) {
        const q = addCode(S[ch] / Sw2, cfg.col[ch], vmax), v = addVal(q, cfg.col[ch], vmax);
        out[ch + 1] = q;
        tot += -2 * v * S[ch] + v * v * Sw2;
      }
      return tot;
    }

    function scoreSums(n, out) {
      S.fill(0);
      for (let i = 0; i < n; i++) {
        const o = idx[i] * 3, w = wBuf ? wBuf[i] : 1, w2 = w * w;
        for (let ch = 0; ch < 3; ch++) {
          const c = cur[o + ch], d = tgt[o + ch] - c, b = ch * 5;
          S[b] += w * d; S[b + 1] += w * d * c; S[b + 2] += w2; S[b + 3] += w2 * c; S[b + 4] += w2 * c * c;
        }
      }
      let best = Infinity;
      for (let q = 0; q < nAlpha; q++) {
        const a = alphas[q];
        let tot = 0;
        const cc = [0, 0, 0];
        for (let ch = 0; ch < 3; ch++) {
          const b = ch * 5, S1 = S[b], S2 = S[b + 1], S3 = S[b + 2], S4 = S[b + 3], S5 = S[b + 4];
          if (S3 <= 0) { cc[ch] = 0; continue; }
          let col = S1 / (a * S3) + S4 / S3;
          col = col < 0 ? 0 : col > 255 ? 255 : col;
          const lv = cLv[ch], qc = Math.round(col / 255 * lv), v = qc * 255 / lv;
          cc[ch] = qc;
          tot += -2 * v * a * S1 + 2 * a * S2 + v * v * a * a * S3 - 2 * v * a * a * S4 + a * a * S5;
        }
        if (tot < best) { best = tot; out[0] = q; out[1] = cc[0]; out[2] = cc[1]; out[3] = cc[2]; }
      }
      return best;
    }

    // error-weighted point sampling
    const cum = new Float64Array(NP);
    function buildCum() {
      let acc = 0;
      for (let i = 0; i < NP; i++) {
        const o = i * 3;
        const a = tgt[o] - cur[o], b = tgt[o + 1] - cur[o + 1], c = tgt[o + 2] - cur[o + 2];
        acc += a * a + b * b + c * c;
        cum[i] = acc;
      }
      return acc;
    }
    function samplePixel() {
      const t = rnd() * cum[NP - 1];
      let lo = 0, hi = NP - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < t) lo = m + 1; else hi = m; }
      return lo;
    }
    const toCode = (x, f) => Math.max(0, Math.min(gmax[f], Math.round(x / R * gmax[f])));
    const rN = 1 << (cfg.rb || 1);
    const radCode = r => Math.max(0, Math.min(rN - 1, Math.round(Math.sqrt(r / (R / 2)) * rN - 1)));
    const logSize = () => Math.exp(Math.log(1.5) + rnd() * (Math.log(R / 2) - Math.log(1.5)));

    function randomShape(codes) {
      const p = samplePixel();
      const px = p % R + rnd(), py = ((p / R) | 0) + rnd();
      const sz = logSize();
      if (cfg.shape === 'tri') {
        codes[0] = toCode(px, 0); codes[1] = toCode(py, 1);
        for (let v = 1; v < 3; v++) {
          codes[2 * v] = toCode(px + (rnd() * 2 - 1) * sz, 2 * v);
          codes[2 * v + 1] = toCode(py + (rnd() * 2 - 1) * sz, 2 * v + 1);
        }
      } else if (cfg.shape === 'ell') {
        codes[0] = toCode(px, 0); codes[1] = toCode(py, 1);
        codes[2] = radCode(sz * (0.2 + 0.8 * rnd()));
        if (!cfg.circle) { codes[3] = radCode(sz * (0.2 + 0.8 * rnd())); codes[4] = Math.floor(rnd() * (gmax[4] + 1)); }
      } else {
        codes[0] = toCode(px - rnd() * sz, 0); codes[1] = toCode(py - rnd() * sz, 1);
        codes[2] = toCode(px + rnd() * sz, 2); codes[3] = toCode(py + rnd() * sz, 3);
      }
    }
    function mutate(src, dst) {
      dst.set(src);
      const nf = rnd() < 0.3 ? 2 : 1;
      let f = Math.floor(rnd() * ng);
      for (let t = 0; t < nf; t++) {
        const m = gmax[f];
        const span = rnd() < 0.5 ? 1 : Math.max(1, Math.round((m + 1) / 16 * rnd() * 2));
        let d = Math.round((rnd() * 2 - 1) * span);
        if (d === 0) d = rnd() < 0.5 ? -1 : 1;
        if (cfg.shape === 'ell' && !cfg.circle && f === 4) dst[f] = (dst[f] + d + m + 1) % (m + 1); // angle wraps
        else dst[f] = Math.max(0, Math.min(m, dst[f] + d));
        f = cfg.shape === 'tri' ? (f ^ 1) : Math.floor(rnd() * ng); // tri: move whole vertex
      }
    }

    const nRand = cfg.nRand || 200, nClimb = cfg.nClimb || 4, maxAge = cfg.maxAge || 100, maxIter = cfg.maxIter || 600;
    const prims = []; // {codes, a, rgb codes}
    const cands = Array.from({ length: nRand }, () => ({ codes: new Int32Array(ng), d: 0, r: new Int32Array(4) }));
    const trial = new Int32Array(ng), tr = new Int32Array(4);
    let sse = buildCum();
    const hist = [];
    const stopFrac = cfg.stopFrac ?? 2e-5;
    let target = L.maxPrims;
    for (let j = 0; j < target; j++) {
      if (j > 0) sse = buildCum();
      for (const c of cands) { randomShape(c.codes); c.d = evaluate(c.codes, c.r, searchSt); }
      cands.sort((a, b) => a.d - b.d);
      let best = null;
      const climb = (c, st, age0, it0) => {
        for (let age = 0, it = 0; age < age0 && it < it0; it++) {
          mutate(c.codes, trial);
          const d = evaluate(trial, tr, st);
          if (d < c.d) { c.codes.set(trial); c.d = d; c.r.set(tr); age = 0; } else age++;
        }
      };
      for (let ci = 0; ci < nClimb; ci++) {
        const c = { codes: cands[ci].codes.slice(), d: cands[ci].d, r: cands[ci].r.slice() };
        climb(c, searchSt, maxAge, maxIter);
        if (searchSt > 1) c.d = evaluate(c.codes, c.r, 1);
        if (!best || c.d < best.d) best = c;
      }
      if (searchSt > 1) climb(best, 1, 30, 150);
      // apply
      G.geom(best.codes, g);
      const n = G.raster(g, idx, 1, wBuf);
      if (add) blendAdd(cur, idx, n, [addVal(best.r[1], crb, vmax), addVal(best.r[2], cgb, vmax), addVal(best.r[3], cbb, vmax)], wBuf);
      else blend(cur, idx, n, [colVal(best.r[1], crb), colVal(best.r[2], cgb), colVal(best.r[3], cbb)], alphas[best.r[0]], wBuf);
      prims.push(best);
      hist.push(-Math.min(0, best.d));
      // early stop when gains become negligible (keep unit-aligned count)
      if (j + 1 >= 50 && j + 1 < target && target === L.maxPrims) {
        let gain = 0;
        for (let t = hist.length - 20; t < hist.length; t++) gain += hist[t];
        if (gain / 20 < stopFrac * sse) {
          target = L.s === 1 ? L.k0 + Math.ceil((j + 1 - L.k0) / L.k) * L.k : j + 1;
        }
      }
    }

    // pack
    const N = prims.length;
    const primBits = p => {
      const bits = [];
      const put = (v, w) => { for (let i = w - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
      for (let f = 0; f < ng; f++) put(p.codes[f], gw[f]);
      put(p.r[1], crb); put(p.r[2], cgb); put(p.r[3], cbb);
      if (cfg.aBits) put(p.r[0], cfg.aBits);
      return bits;
    };
    const header = (id) => { const b = []; for (let i = L.u - 1; i >= 0; i--) b.push((id >>> i) & 1); return b; };
    const units = [];
    const u0 = header(0);
    for (let i = 15; i >= 0; i--) u0.push((bg.code >>> i) & 1);
    units.push(u0);
    if (L.s === 1) {
      for (let j = 0; j < Math.min(N, L.k0); j++) units[0].push(...primBits(prims[j]));
      for (let j = L.k0; j < N; j += L.k) {
        const u = header(units.length);
        for (let t = 0; t < L.k; t++) u.push(...primBits(prims[j + t]));
        units.push(u);
      }
    } else {
      for (let j = 0; j < N; j++) {
        const b = primBits(prims[j]);
        units.push(header(units.length).concat(b.slice(0, L.pay)));
        units.push(header(units.length).concat(b.slice(L.pay)));
      }
    }
    // per-unit SSE reduction (for RD merging in hybrid codecs); unit 0 also carries the background
    const gains = new Array(units.length).fill(0);
    gains[0] = Infinity;
    for (let j = 0; j < N; j++) {
      if (L.s === 1) { const [uid] = primLoc(L, j); gains[uid] += hist[j]; }
      else { gains[1 + 2 * j] += hist[j] / 2; gains[2 + 2 * j] += hist[j] / 2; }
    }
    const nb = Math.min(N, Math.max(50, Math.ceil(0.12 * N)));
    const baseCount = L.s === 1 ? (nb <= L.k0 ? 1 : 1 + Math.ceil((nb - L.k0) / L.k)) : 1 + 2 * nb;
    return { units, baseCount: Math.min(baseCount, units.length), gains };
  },

  decoder(cfg, P) {
    const L = layout(cfg, P);
    const R = cfg.R, G = makeGeom(cfg);
    const wBuf = cfg.soft ? new Float64Array(R * R) : null;
    const store = new Array(1 << L.u).fill(null);
    const ng = L.ng, gw = L.widths.slice(0, ng);
    return {
      stateInfo: `${L.maxPrims} prims x ${L.primBits} bits (${cfg.shape}), s=${L.s} k=${L.k}, loop ${L.maxPrims} x ${R}^2`,
      apply(bits) {
        const rd = new BitReader(bits);
        const id = rd.read(L.u);
        if (id >= L.units) return;
        store[id] = bits.slice(L.u, L.u + L.pay);
      },
      render(base) {
        const cur = new Float64Array(R * R * 3);
        const bg = store[0] ? from565(new BitReader(store[0]).read(16)) : [128, 128, 128];
        if (base) cur.set(I.resize(base, R, R).data); else for (let i = 0; i < cur.length; i++) cur[i] = bg[i % 3];
        const idx = new Int32Array(R * R), g = new Float64Array(6), codes = new Int32Array(ng);
        for (let j = 0; j < L.maxPrims; j++) {
          let rd;
          if (L.s === 1) {
            const [uid, off] = primLoc(L, j);
            if (!store[uid]) continue;
            rd = new BitReader(store[uid]); rd.pos = off;
          } else {
            const a = store[1 + 2 * j], b = store[2 + 2 * j];
            if (!a || !b) continue;
            rd = new BitReader(a.concat(b));
          }
          for (let f = 0; f < ng; f++) codes[f] = rd.read(gw[f]);
          const rgb = cfg.blend === 'add'
            ? cfg.col.map(w => addVal(rd.read(w), w, cfg.vmax || 255))
            : cfg.col.map(w => colVal(rd.read(w), w));
          const a = alphaVal(cfg, cfg.aBits ? rd.read(cfg.aBits) : 0);
          G.geom(codes, g);
          const n = G.raster(g, idx, 1, wBuf);
          if (cfg.blend === 'add') blendAdd(cur, idx, n, rgb, wBuf);
          else blend(cur, idx, n, rgb, a, wBuf);
        }
        return I.quantize8(I.resize({ w: R, h: R, c: 3, data: cur }, cfg.out || 256, cfg.out || 256)); // cfg.out: display size (default 256)
      },
    };
  },
};
