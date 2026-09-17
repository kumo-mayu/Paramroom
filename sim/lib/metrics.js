'use strict';
// Quality metrics against a reference RGB image (0..255).
// PSNR on RGB; SSIM and MS-SSIM on luma (BT.601), Gaussian window 11, sigma 1.5 (Wang et al.).

function luma(img) {
  const n = img.w * img.h, out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.299 * img.data[i * 3] + 0.587 * img.data[i * 3 + 1] + 0.114 * img.data[i * 3 + 2];
  return { w: img.w, h: img.h, d: out };
}

function psnr(ref, img) {
  let se = 0;
  for (let i = 0; i < ref.data.length; i++) {
    const e = ref.data[i] - Math.max(0, Math.min(255, img.data[i]));
    se += e * e;
  }
  const mse = se / ref.data.length;
  return mse === 0 ? 99 : 10 * Math.log10(255 * 255 / mse);
}

const G = (() => {
  const g = [], s = 1.5;
  let sum = 0;
  for (let i = -5; i <= 5; i++) { g.push(Math.exp(-i * i / (2 * s * s))); sum += g[g.length - 1]; }
  return g.map(v => v / sum);
})();

// separable 'valid' gaussian filtering
// (taps unrolled; summation order identical to the plain k=0..10 loop => bit-identical results)
const [G0, G1, G2, G3, G4, G5, G6, G7, G8, G9, G10] = G;
function blur(p) {
  const { w, h, d } = p, W = w - 10, H = h - 10;
  const tmp = new Float64Array(W * h), out = new Float64Array(W * H);
  for (let y = 0; y < h; y++) {
    const r = y * w, o = y * W;
    for (let x = 0; x < W; x++) {
      const i = r + x;
      let s = 0;
      s += G0 * d[i]; s += G1 * d[i + 1]; s += G2 * d[i + 2]; s += G3 * d[i + 3]; s += G4 * d[i + 4]; s += G5 * d[i + 5];
      s += G6 * d[i + 6]; s += G7 * d[i + 7]; s += G8 * d[i + 8]; s += G9 * d[i + 9]; s += G10 * d[i + 10];
      tmp[o + x] = s;
    }
  }
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) {
      const i = o + x;
      let s = 0;
      s += G0 * tmp[i]; s += G1 * tmp[i + W]; s += G2 * tmp[i + 2 * W]; s += G3 * tmp[i + 3 * W]; s += G4 * tmp[i + 4 * W]; s += G5 * tmp[i + 5 * W];
      s += G6 * tmp[i + 6 * W]; s += G7 * tmp[i + 7 * W]; s += G8 * tmp[i + 8 * W]; s += G9 * tmp[i + 9 * W]; s += G10 * tmp[i + 10 * W];
      out[o + x] = s;
    }
  }
  return { w: W, h: H, d: out };
}

function mul(a, b) {
  const d = new Float64Array(a.d.length);
  for (let i = 0; i < d.length; i++) d[i] = a.d[i] * b.d[i];
  return { w: a.w, h: a.h, d };
}

const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;

// returns [meanSSIM, meanCS]
function ssimComponents(x, y) {
  const mx = blur(x), my = blur(y);
  const sxx = blur(mul(x, x)), syy = blur(mul(y, y)), sxy = blur(mul(x, y));
  let ss = 0, cs = 0;
  const n = mx.d.length;
  for (let i = 0; i < n; i++) {
    const ux = mx.d[i], uy = my.d[i];
    const vx = sxx.d[i] - ux * ux, vy = syy.d[i] - uy * uy, cxy = sxy.d[i] - ux * uy;
    const c = (2 * cxy + C2) / (vx + vy + C2);
    cs += c;
    ss += ((2 * ux * uy + C1) / (ux * ux + uy * uy + C1)) * c;
  }
  return [ss / n, cs / n];
}

function down2(p) {
  const W = p.w >> 1, H = p.h >> 1, d = new Float64Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      d[y * W + x] = (p.d[2 * y * p.w + 2 * x] + p.d[2 * y * p.w + 2 * x + 1] + p.d[(2 * y + 1) * p.w + 2 * x] + p.d[(2 * y + 1) * p.w + 2 * x + 1]) / 4;
  return { w: W, h: H, d };
}

function clampLuma(p) {
  for (let i = 0; i < p.d.length; i++) p.d[i] = Math.max(0, Math.min(255, p.d[i]));
  return p;
}

function ssim(ref, img) {
  return ssimComponents(luma(ref), clampLuma(luma(img)))[0];
}

const MS_W = [0.0448, 0.2856, 0.3001, 0.2363, 0.1333];
function msssim(ref, img) {
  let x = luma(ref), y = clampLuma(luma(img));
  let val = 1;
  for (let s = 0; s < 5; s++) {
    const [ss, cs] = ssimComponents(x, y);
    if (s === 4) val *= Math.pow(Math.max(ss, 1e-6), MS_W[s]);
    else val *= Math.pow(Math.max(cs, 1e-6), MS_W[s]);
    x = down2(x); y = down2(y);
  }
  return val;
}

// Planar YCbCr (BT.601 full range) for colour-aware SSIM.
function yccPlanes(img) {
  const n = img.w * img.h, Y = new Float64Array(n), Cb = new Float64Array(n), Cr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.max(0, Math.min(255, img.data[i * 3])), g = Math.max(0, Math.min(255, img.data[i * 3 + 1])), b = Math.max(0, Math.min(255, img.data[i * 3 + 2]));
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
    Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
  }
  return [Y, Cb, Cr].map(d => ({ w: img.w, h: img.h, d }));
}

function msssimPlane(x, y) {
  let val = 1, s0 = 0;
  for (let s = 0; s < 5; s++) {
    const [ss, cs] = ssimComponents(x, y);
    if (s === 0) s0 = ss;
    if (s === 4) val *= Math.pow(Math.max(ss, 1e-6), MS_W[s]);
    else val *= Math.pow(Math.max(cs, 1e-6), MS_W[s]);
    x = down2(x); y = down2(y);
  }
  return [s0, val];
}

// Reference-side pyramid (planes, blurred means, blurred squares per scale) cached per reference object:
// each call then needs 3 blurs per scale instead of 5. Same arithmetic => identical results.
const refCache = new WeakMap();
function refPyramid(ref) {
  let pyr = refCache.get(ref);
  if (pyr) return pyr;
  pyr = yccPlanes(ref).map(x => {
    const levels = [];
    for (let s = 0; s < 5; s++) {
      levels.push({ x, mx: blur(x), sxx: blur(mul(x, x)) });
      x = down2(x);
    }
    return levels;
  });
  refCache.set(ref, pyr);
  return pyr;
}

function msssimPlaneCached(levels, y) {
  let val = 1, s0 = 0;
  for (let s = 0; s < 5; s++) {
    const { x, mx, sxx } = levels[s];
    const my = blur(y), syy = blur(mul(y, y)), sxy = blur(mul(x, y));
    let ss = 0, cs = 0;
    const n = mx.d.length;
    for (let i = 0; i < n; i++) {
      const ux = mx.d[i], uy = my.d[i];
      const vx = sxx.d[i] - ux * ux, vy = syy.d[i] - uy * uy, cxy = sxy.d[i] - ux * uy;
      const c = (2 * cxy + C2) / (vx + vy + C2);
      cs += c;
      ss += ((2 * ux * uy + C1) / (ux * ux + uy * uy + C1)) * c;
    }
    ss /= n; cs /= n;
    if (s === 0) s0 = ss;
    if (s === 4) val *= Math.pow(Math.max(ss, 1e-6), MS_W[s]);
    else val *= Math.pow(Math.max(cs, 1e-6), MS_W[s]);
    y = down2(y);
  }
  return [s0, val];
}

// psnr: RGB. ssim/msssim: luma only. ssimc/msssimc: YCbCr weighted 6:1:1 (colour-aware; default ranking metric).
function all(ref, img) {
  const pyr = refPyramid(ref), b = yccPlanes(img);
  const r = [0, 1, 2].map(k => msssimPlaneCached(pyr[k], b[k]));
  return {
    psnr: psnr(ref, img),
    ssim: r[0][0], msssim: r[0][1],
    ssimc: (6 * r[0][0] + r[1][0] + r[2][0]) / 8,
    msssimc: (6 * r[0][1] + r[1][1] + r[2][1]) / 8,
  };
}

module.exports = { psnr, ssim, msssim, all, allUncached: (ref, img) => { const a = yccPlanes(ref), b = yccPlanes(img); const r = [0, 1, 2].map(k => msssimPlane(a[k], b[k])); return { psnr: psnr(ref, img), ssim: r[0][0], msssim: r[0][1], ssimc: (6 * r[0][0] + r[1][0] + r[2][0]) / 8, msssimc: (6 * r[0][1] + r[1][1] + r[2][1]) / 8 }; } };
