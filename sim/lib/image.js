'use strict';
// Image utilities. Images are {w, h, c, data: Float64Array} with values in 0..255, interleaved channels.
const fs = require('fs');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

function create(w, h, c = 3, fill = 0) {
  const data = new Float64Array(w * h * c);
  if (fill) data.fill(fill);
  return { w, h, c, data };
}

// Loads PNG or JPEG (detected by magic bytes).
function loadPNG(path) {
  const buf = fs.readFileSync(path);
  const png = buf[0] === 0xff && buf[1] === 0xd8 ? jpeg.decode(buf, { useTArray: true }) : PNG.sync.read(buf);
  const img = create(png.width, png.height, 3);
  for (let i = 0, j = 0; i < png.width * png.height; i++, j += 4) {
    const a = png.data[j + 3] / 255;
    // composite on white
    img.data[i * 3] = png.data[j] * a + 255 * (1 - a);
    img.data[i * 3 + 1] = png.data[j + 1] * a + 255 * (1 - a);
    img.data[i * 3 + 2] = png.data[j + 2] * a + 255 * (1 - a);
  }
  return img;
}

function savePNG(img, path) {
  const png = new PNG({ width: img.w, height: img.h });
  for (let i = 0; i < img.w * img.h; i++) {
    for (let k = 0; k < 3; k++) {
      const v = img.c === 1 ? img.data[i] : img.data[i * 3 + k];
      png.data[i * 4 + k] = Math.max(0, Math.min(255, Math.round(v)));
    }
    png.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(path, PNG.sync.write(png));
}

function crop(img, x0, y0, w, h) {
  const out = create(w, h, img.c);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let k = 0; k < img.c; k++)
        out.data[(y * w + x) * img.c + k] = img.data[((y + y0) * img.w + (x + x0)) * img.c + k];
  return out;
}

// Area-average downscale (exact box filter for arbitrary ratio).
function resizeArea(img, W, H) {
  const out = create(W, H, img.c);
  const sx = img.w / W, sy = img.h / H;
  for (let Y = 0; Y < H; Y++) {
    const y0 = Y * sy, y1 = (Y + 1) * sy;
    for (let X = 0; X < W; X++) {
      const x0 = X * sx, x1 = (X + 1) * sx;
      const acc = new Float64Array(img.c);
      let wsum = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          const wgt = wx * wy;
          wsum += wgt;
          for (let k = 0; k < img.c; k++) acc[k] += img.data[(y * img.w + x) * img.c + k] * wgt;
        }
      }
      for (let k = 0; k < img.c; k++) out.data[(Y * W + X) * img.c + k] = acc[k] / wsum;
    }
  }
  return out;
}

// Bilinear resample with texel-center alignment (like a GPU bilinear sampler, clamp addressing).
function resizeBilinear(img, W, H) {
  const out = create(W, H, img.c);
  for (let Y = 0; Y < H; Y++) {
    const fy = Math.min(Math.max((Y + 0.5) * img.h / H - 0.5, 0), img.h - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, img.h - 1), ty = fy - y0;
    for (let X = 0; X < W; X++) {
      const fx = Math.min(Math.max((X + 0.5) * img.w / W - 0.5, 0), img.w - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, img.w - 1), tx = fx - x0;
      for (let k = 0; k < img.c; k++) {
        const a = img.data[(y0 * img.w + x0) * img.c + k], b = img.data[(y0 * img.w + x1) * img.c + k];
        const c = img.data[(y1 * img.w + x0) * img.c + k], d = img.data[(y1 * img.w + x1) * img.c + k];
        out.data[(Y * W + X) * img.c + k] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      }
    }
  }
  return out;
}

function resize(img, W, H) {
  if (W === img.w && H === img.h) return { ...img, data: img.data.slice() };
  if (W <= img.w && H <= img.h) return resizeArea(img, W, H);
  return resizeBilinear(img, W, H);
}

// JPEG (BT.601 full range) color conversion. Returns 3 planar channel images.
function rgbToYcc(img) {
  const n = img.w * img.h;
  const Y = create(img.w, img.h, 1), Cb = create(img.w, img.h, 1), Cr = create(img.w, img.h, 1);
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 3], g = img.data[i * 3 + 1], b = img.data[i * 3 + 2];
    Y.data[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb.data[i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
    Cr.data[i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
  }
  return [Y, Cb, Cr];
}

function yccToRgb(Y, Cb, Cr) {
  const img = create(Y.w, Y.h, 3);
  for (let i = 0; i < Y.w * Y.h; i++) {
    const y = Y.data[i], cb = Cb.data[i] - 128, cr = Cr.data[i] - 128;
    img.data[i * 3] = y + 1.402 * cr;
    img.data[i * 3 + 1] = y - 0.344136 * cb - 0.714136 * cr;
    img.data[i * 3 + 2] = y + 1.772 * cb;
  }
  return img;
}

function clamp255(img) {
  for (let i = 0; i < img.data.length; i++) img.data[i] = Math.max(0, Math.min(255, img.data[i]));
  return img;
}

// Quantize to 8-bit like an RGBA8 render target would.
function quantize8(img) {
  for (let i = 0; i < img.data.length; i++) img.data[i] = Math.max(0, Math.min(255, Math.round(img.data[i])));
  return img;
}

module.exports = { create, loadPNG, savePNG, crop, resize, resizeArea, resizeBilinear, rgbToYcc, yccToRgb, clamp255, quantize8 };
