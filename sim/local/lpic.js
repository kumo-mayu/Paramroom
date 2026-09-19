'use strict';
// Paramroom local image format v1 ("lpic") - encoder and reference decoder (docs/research/12, 13).
//
// For the local path (PC -> OSC -> the wearer's own avatar): the transport carries independent chunks of 31 x 28 bits
// (measure/unity/Assets/ParamroomLocalImage, ParamroomLocalGroup.shader). This format fills them with a baseline-JPEG
// style image that a shader can decode:
//   - YCbCr 4:4:4 (JFIF full range), 8x8 DCT, JPEG base quantisation tables scaled by the quality (libjpeg integer
//     formula, so the shader computes the same tables), JPEG standard Huffman tables (Annex K) - no tables are sent
//   - blocks in order i = 3 * (by * bw + bx) + comp (comp 0 Y, 1 Cb, 2 Cr)
//   - chunk 0 = header:   w1 = [width 12][height 12][version 4 = 1]   w2 = [quality 7][chunks 16][0 5]
//     chunk c >= 1:       w1 = [first block 20][blocks 8]            w2..w31 = 840-bit stream, MSB first
//   - a block never spans two chunks, and the DC prediction restarts at every chunk: any chunk decodes on its own
// The reference decoder does what the shaders do, in the same order and in float32 (Math.fround), so the Unity test
// can compare the shader's picture with it (a difference of 1 is expected where float rounding differs).
//
//   node lpic.js encode <image.png|jpg> [--quality 85] [--max 1024] [--out <prefix>]
//     -> <prefix>.lpic.json (chunks), <prefix>-expected.png (reference decode), and a summary line
const fs = require('fs');
const path = require('path');
const I = require('../lib/image');
const D = require('../lib/dct');

const WORD_BITS = 28, DATA_WORDS = 30, DATA_BITS = WORD_BITS * DATA_WORDS; // 840
const MAX_SIDE = 1024, MAX_CHUNKS = 4096;

// ---- JPEG standard Huffman tables (Annex K.3, as in jpeg-js)
const STD = {
  dc: [
    { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
    { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  ],
  ac: [
    { bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d], vals: [
      0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
      0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
      0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
      0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
      0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
      0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
      0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa] },
    { bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], vals: [
      0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
      0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
      0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
      0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
      0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
      0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
      0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa] },
  ],
};

// canonical codes: enc[sym] = { code, len }; dec = { maxcode[1..16], valptr[1..16], mincode[1..16], vals }
function buildTable({ bits, vals }) {
  const enc = new Map();
  const mincode = new Int32Array(17), maxcode = new Int32Array(17).fill(-1), valptr = new Int32Array(17);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    valptr[len] = k; mincode[len] = code;
    for (let i = 0; i < bits[len - 1]; i++) { enc.set(vals[k], { code, len }); code++; k++; }
    maxcode[len] = bits[len - 1] ? code - 1 : -1;
    code <<= 1;
  }
  return { enc, mincode, maxcode, valptr, vals };
}
const TBL = { dc: STD.dc.map(buildTable), ac: STD.ac.map(buildTable) };

// ---- quantisation (libjpeg integer scaling: the shader computes the same)
function qScale(q) { return q < 50 ? Math.floor(5000 / q) : 200 - 2 * q; }
function qTables(q) {
  const s = qScale(q);
  const mk = t => t.map(v => Math.max(1, Math.min(255, Math.floor((v * s + 50) / 100))));
  return [mk(D.QY), mk(D.QC)];
}

const bitSize = v => (v === 0 ? 0 : 32 - Math.clz32(Math.abs(v)));
const extraBits = (v, s) => (v >= 0 ? v : v + (1 << s) - 1);

// ---- bit writer into 28-bit words
class Bits {
  constructor() { this.words = new Array(DATA_WORDS).fill(0); this.pos = 0; }
  put(v, n) {
    for (let i = n - 1; i >= 0; i--) {
      const b = (v >>> i) & 1, w = Math.floor(this.pos / WORD_BITS), o = WORD_BITS - 1 - (this.pos % WORD_BITS);
      if (b) this.words[w] |= 1 << o;
      this.pos++;
    }
  }
}

function blockCode(q, pred, t) {
  // list of [value, nbits]
  const out = [];
  const dd = q[0] - pred, ds = bitSize(dd);
  const dc = TBL.dc[t].enc.get(ds);
  out.push([dc.code, dc.len]); if (ds) out.push([extraBits(dd, ds), ds]);
  let last = 0;
  for (let k = 63; k >= 1; k--) if (q[D.ZIGZAG[k]] !== 0) { last = k; break; }
  let run = 0;
  for (let k = 1; k <= last; k++) {
    const v = q[D.ZIGZAG[k]];
    if (v === 0) { run++; continue; }
    while (run > 15) { const z = TBL.ac[t].enc.get(0xf0); out.push([z.code, z.len]); run -= 16; }
    const s = bitSize(v), a = TBL.ac[t].enc.get((run << 4) | s);
    out.push([a.code, a.len], [extraBits(v, s), s]); run = 0;
  }
  if (last < 63) { const e = TBL.ac[t].enc.get(0); out.push([e.code, e.len]); }
  return out;
}
const codeLen = c => c.reduce((a, [, n]) => a + n, 0);

// ---- colour (JFIF)
function toYcc(img) {
  const n = img.w * img.h, P = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 3], g = img.data[i * 3 + 1], b = img.data[i * 3 + 2];
    P[0][i] = 0.299 * r + 0.587 * g + 0.114 * b;
    P[1][i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
    P[2][i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
  }
  return P;
}

function encode(img, quality) {
  const W = img.w, H = img.h, bw = Math.ceil(W / 8), bh = Math.ceil(H / 8);
  if (W > MAX_SIDE || H > MAX_SIDE) throw new Error('image larger than ' + MAX_SIDE);
  const P = toYcc(img), QT = qTables(quality);
  const blocks = [];
  const blk = new Float64Array(64), cf = new Float64Array(64);
  for (let b = 0; b < bw * bh; b++) {
    const bx = b % bw, by = Math.floor(b / bw);
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const X = Math.min(bx * 8 + x, W - 1), Y = Math.min(by * 8 + y, H - 1);
        blk[y * 8 + x] = P[c][Y * W + X] - 128;
      }
      D.fdct(blk, cf);
      const qt = QT[c ? 1 : 0], q = new Int32Array(64);
      for (let k = 0; k < 64; k++) q[k] = Math.round(cf[k] / qt[k]);
      blocks.push(q);
    }
  }
  // pack
  const chunks = [];
  let cur = null, pred = [0, 0, 0];
  const flush = () => { if (cur) { cur.words[0] = ((cur.first & 0xFFFFF) << 8) | cur.n; chunks.push(cur); } };
  blocks.forEach((q, i) => {
    const c = i % 3, t = c ? 1 : 0;
    let code = cur ? blockCode(q, pred[c], t) : null;
    if (!cur || cur.n === 255 || cur.bits.pos + codeLen(code) > DATA_BITS) {
      flush();
      cur = { first: i, n: 0, bits: new Bits(), words: null };
      cur.words = [0].concat(cur.bits.words); // w1 filled at flush, w2.. = the stream (shared array below)
      pred = [0, 0, 0];
      code = blockCode(q, 0, t);
      if (codeLen(code) > DATA_BITS) throw new Error('block larger than a chunk');
    }
    for (const [v, n] of code) cur.bits.put(v, n);
    cur.words = [0].concat(cur.bits.words);
    cur.n++; pred[c] = q[0];
  });
  flush();
  const nChunks = chunks.length + 1;
  if (nChunks > MAX_CHUNKS) throw new Error(`${nChunks} chunks > ${MAX_CHUNKS}: lower the quality or the size`);
  const header = new Array(31).fill(0);
  header[0] = (W << 16) | (H << 4) | 1;
  header[1] = (quality << 21) | (nChunks << 5);
  return { w: W, h: H, quality, chunks: [header].concat(chunks.map(c => c.words)) };
}

// ---- reference decoder (mirrors the shaders; float32 where they use float)
const f = Math.fround;
const COS32 = (() => { // COS32[x * 8 + u] = C(u)/2 * cos((2x+1) u pi / 16), float32
  const c = new Float32Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) c[x * 8 + u] = Math.cos((2 * x + 1) * u * Math.PI / 16) * (u === 0 ? Math.SQRT1_2 : 1) * 0.5;
  return c;
})();

function decode(lp) {
  const { w: W, h: H, quality, chunks } = lp;
  const bw = Math.ceil(W / 8), bh = Math.ceil(H / 8), nBlocks = 3 * bw * bh;
  const QT = qTables(quality);
  const firsts = chunks.map((c, i) => (i === 0 ? -1 : c[0] >>> 8));
  const counts = chunks.map((c, i) => (i === 0 ? 0 : c[0] & 255));
  // bit reader over one chunk's stream (words 1..30)
  const bit = (ch, p) => (chunks[ch][1 + Math.floor(p / WORD_BITS)] >>> (WORD_BITS - 1 - (p % WORD_BITS))) & 1;
  const read = (ch, p, n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bit(ch, p + i); return v; };
  function huff(ch, p, T) {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | bit(ch, p + len - 1);
      if (T.maxcode[len] >= 0 && code <= T.maxcode[len]) return { sym: T.vals[T.valptr[len] + code - T.mincode[len]], len };
    }
    return { sym: 0, len: 16 };
  }
  const extend = (v, s) => (s === 0 ? 0 : v < (1 << (s - 1)) ? v - (1 << s) + 1 : v);
  // parse one block at p: returns { p, dcDiff, coef (quantised, raster) }
  function parseBlock(ch, p, t, wantCoef) {
    const d = huff(ch, p, TBL.dc[t]); p += d.len;
    const dcDiff = extend(read(ch, p, d.sym), d.sym); p += d.sym;
    const coef = wantCoef ? new Int32Array(64) : null;
    for (let k = 1; k < 64;) {
      const a = huff(ch, p, TBL.ac[t]); p += a.len;
      const r = a.sym >> 4, s = a.sym & 15;
      if (s === 0) { if (r === 15) { k += 16; continue; } break; }
      k += r;
      if (wantCoef && k < 64) coef[D.ZIGZAG[k]] = extend(read(ch, p, s), s);
      p += s; k++;
    }
    return { p, dcDiff, coef };
  }
  // stage A: block -> (chunk, bit offset, absolute DC)  [ParamroomLocalBlockMap.shader]
  const map = new Array(nBlocks);
  for (let i = 0; i < nBlocks; i++) {
    let lo = 1, hi = chunks.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (firsts[mid] <= i) lo = mid; else hi = mid - 1; }
    const ch = lo; const c = i % 3;
    if (!(firsts[ch] <= i && i < firsts[ch] + counts[ch])) throw new Error('block ' + i + ' not found');
    let p = 0, dc = 0;
    for (let j = firsts[ch]; j < i; j++) {
      const r = parseBlock(ch, p, j % 3 ? 1 : 0, false);
      if (j % 3 === c) dc += r.dcDiff;
      p = r.p;
    }
    map[i] = { ch, p, dc };
  }
  // stage C1: vertical IDCT per column: t(u, y) = sum_v COS[y][v] * F(u, v)   [ParamroomLocalIdctV.shader]
  // stage C2: horizontal: val(x, y) = sum_u COS[x][u] * t(u, y), + 128, YCbCr -> RGB   [ParamroomLocalIdctH.shader]
  const out = I.create(W, H, 3);
  const T = new Float32Array(64 * 3);
  for (let b = 0; b < bw * bh; b++) {
    const bx = b % bw, by = Math.floor(b / bw);
    for (let c = 0; c < 3; c++) {
      const m = map[3 * b + c];
      const r = parseBlock(m.ch, m.p, c ? 1 : 0, true);
      const F = new Float32Array(64), qt = QT[c ? 1 : 0];
      for (let k = 0; k < 64; k++) F[k] = f(r.coef[k] * qt[k]);
      F[0] = f((m.dc + r.dcDiff) * qt[0]);
      for (let u = 0; u < 8; u++) for (let y = 0; y < 8; y++) {
        let s = 0;
        for (let v = 0; v < 8; v++) s = f(s + f(COS32[y * 8 + v] * F[v * 8 + u]));
        T[c * 64 + y * 8 + u] = s;
      }
    }
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const X = bx * 8 + x, Y = by * 8 + y;
      if (X >= W || Y >= H) continue;
      const v = [0, 1, 2].map(c => { let s = 0; for (let u = 0; u < 8; u++) s = f(s + f(COS32[x * 8 + u] * T[c * 64 + y * 8 + u])); return f(s + 128); });
      const [Yv, Cb, Cr] = v;
      const rgb = [f(Yv + f(1.402 * f(Cr - 128))), f(f(Yv - f(0.344136 * f(Cb - 128))) - f(0.714136 * f(Cr - 128))), f(Yv + f(1.772 * f(Cb - 128)))];
      for (let k = 0; k < 3; k++) out.data[(Y * W + X) * 3 + k] = Math.min(255, Math.max(0, Math.round(rgb[k])));
    }
  }
  return out;
}

function loadAny(file) {
  if (/\.png$/i.test(file)) return I.loadPNG(file);
  const jpeg = require('jpeg-js');
  const d = jpeg.decode(fs.readFileSync(file), { useTArray: true, formatAsRGBA: true });
  const img = I.create(d.width, d.height, 3);
  for (let i = 0; i < d.width * d.height; i++) for (let k = 0; k < 3; k++) img.data[i * 3 + k] = d.data[i * 4 + k];
  return img;
}
function fit(img, max) {
  const s = Math.min(1, max / Math.max(img.w, img.h));
  if (s >= 1) return img;
  return I.resizeArea(img, Math.max(1, Math.round(img.w * s)), Math.max(1, Math.round(img.h * s)));
}

module.exports = { encode, decode, qTables, TBL, STD, DATA_BITS, WORD_BITS, loadAny, fit };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
  if (argv[0] !== 'encode' || !argv[1]) { console.log('usage: node lpic.js encode <image> [--quality 85] [--max 1024] [--out prefix]'); process.exit(1); }
  const quality = Number(opt('quality', 85)), max = Number(opt('max', 1024));
  const img = I.quantize8(fit(loadAny(argv[1]), max));
  const t0 = Date.now();
  const lp = encode(img, quality);
  const tEnc = Date.now() - t0;
  const rec = decode(lp);
  const prefix = opt('out', argv[1].replace(/\.[^.]+$/, '') + `-q${quality}`);
  fs.writeFileSync(prefix + '.lpic.json', JSON.stringify(lp));
  I.savePNG(rec, prefix + '-expected.png');
  const M = require('../lib/metrics');
  const m = M.all(img, rec);
  const bits = lp.chunks.length * 868;
  console.log(JSON.stringify({ w: lp.w, h: lp.h, quality, chunks: lp.chunks.length, bits, bpp: +(bits / (lp.w * lp.h)).toFixed(3),
    msssimc: +m.msssimc.toFixed(4), psnr: +m.psnr.toFixed(2), encodeMs: tEnc, out: prefix }));
}
