'use strict';
// 8x8 orthonormal DCT-II, zigzag order, JPEG base quantization tables.

const N = 8;
const COS = new Float64Array(64);
for (let x = 0; x < 8; x++)
  for (let u = 0; u < 8; u++)
    COS[x * 8 + u] = Math.cos((2 * x + 1) * u * Math.PI / 16) * (u === 0 ? Math.SQRT1_2 : 1) * 0.5;

// forward: block (64, spatial) -> coef (64, raster u,v index v*8+u)
function fdct(block, out = new Float64Array(64)) {
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < 8; y++) {
        const cy = COS[y * 8 + v];
        for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[x * 8 + u] * cy;
      }
      out[v * 8 + u] = s;
    }
  return out;
}

function idct(coef, out = new Float64Array(64)) {
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let v = 0; v < 8; v++) {
        const cy = COS[y * 8 + v];
        for (let u = 0; u < 8; u++) {
          const c = coef[v * 8 + u];
          if (c !== 0) s += c * COS[x * 8 + u] * cy;
        }
      }
      out[y * 8 + x] = s;
    }
  return out;
}

// ZIGZAG[k] = raster index of k-th zigzag coefficient
const ZIGZAG = (() => {
  const z = [];
  for (let s = 0; s < 15; s++) {
    const cells = [];
    for (let v = 0; v < 8; v++) { const u = s - v; if (u >= 0 && u < 8) cells.push(v * 8 + u); }
    if (s % 2 === 0) cells.reverse();
    z.push(...cells);
  }
  return z;
})();

// JPEG Annex K tables (raster order)
const QY = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];

// Split a planar channel {w,h,data} (w,h multiples of 8) into blocks of quantized-ready coefficients.
function planeToCoefs(plane) {
  const bw = plane.w / 8, bh = plane.h / 8;
  const coefs = new Float64Array(bw * bh * 64);
  const blk = new Float64Array(64), tmp = new Float64Array(64);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) blk[y * 8 + x] = plane.data[(by * 8 + y) * plane.w + bx * 8 + x] - 128;
      fdct(blk, tmp);
      coefs.set(tmp, (by * bw + bx) * 64);
    }
  return { bw, bh, coefs };
}

function coefsToPlane(bw, bh, coefs) {
  const w = bw * 8, h = bh * 8;
  const data = new Float64Array(w * h);
  const tmp = new Float64Array(64), out = new Float64Array(64);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      for (let i = 0; i < 64; i++) tmp[i] = coefs[(by * bw + bx) * 64 + i];
      idct(tmp, out);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) data[(by * 8 + y) * w + bx * 8 + x] = out[y * 8 + x] + 128;
    }
  return { w, h, c: 1, data };
}

module.exports = { fdct, idct, ZIGZAG, QY, QC, planeToCoefs, coefsToPlane };
