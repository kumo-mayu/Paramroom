'use strict';
// ローカル転送用の符号化方式（docs/research/12）。どれも「ビット数」と「再構成画像」を返す。
// ビット数は受信側が復号に要る情報をすべて数える（パレット・表・ブロック先頭の位置など）。
// 各方式の run(img, p) → { bits, rec }。p は方式ごとの設定（レートを動かす軸を含む）。
const C = require('./common');
const I = C.I;
const D = require('../lib/dct');
const jpeg = require('jpeg-js');

const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v);
const log2c = n => Math.ceil(Math.log2(n));

// ======================================================================================
// 1. raw / 量子化画素
// ======================================================================================
function qlev(v, b) { const L = (1 << b) - 1; return Math.round(clamp(v) * L / 255) * 255 / L; }

function rawRGB(img, p) {
  const [br, bg, bb] = p.bits;
  const rec = I.create(img.w, img.h, 3);
  for (let i = 0; i < img.w * img.h; i++) {
    rec.data[i * 3] = qlev(img.data[i * 3], br);
    rec.data[i * 3 + 1] = qlev(img.data[i * 3 + 1], bg);
    rec.data[i * 3 + 2] = qlev(img.data[i * 3 + 2], bb);
  }
  return { bits: img.w * img.h * (br + bg + bb), rec };
}

// YCbCr 4:2:0（色差は縦横半分）。Y を yb bit、色差を cb bit
function rawYcc(img, p) {
  const [Y, Cb, Cr] = C.toPlanes(img);
  const w2 = Math.ceil(img.w / 2), h2 = Math.ceil(img.h / 2);
  const q = (pl, b) => { for (let i = 0; i < pl.data.length; i++) pl.data[i] = qlev(pl.data[i], b); return pl; };
  q(Y, p.yb);
  const cb = q(I.resize(Cb, w2, h2), p.cb), cr = q(I.resize(Cr, w2, h2), p.cb);
  const rec = C.fromPlanes(Y, I.resizeBilinear(cb, img.w, img.h), I.resizeBilinear(cr, img.w, img.h));
  return { bits: img.w * img.h * p.yb + 2 * w2 * h2 * p.cb, rec };
}

// ======================================================================================
// 2. ブロック系（BC1/BTC の一般化）: bs×bs ブロックごとに 2 端点（ep bit/ch）と、端点間を L=2^ib 段に割った添字
// ======================================================================================
function quantEp(c, ep) { return [0, 1, 2].map(k => qlev(c[k], ep[k])); }

function blockCodec(img, p) {
  const bs = p.bs, L = 1 << p.ib, W = img.w, H = img.h;
  const rec = I.create(W, H, 3);
  const nbx = Math.ceil(W / bs), nby = Math.ceil(H / bs);
  const px = new Float64Array(bs * bs * 3);
  const idx = new Int32Array(bs * bs);
  for (let by = 0; by < nby; by++)
    for (let bx = 0; bx < nbx; bx++) {
      // 端のブロックは画素を複製して埋める
      let n = 0;
      const pos = [];
      for (let y = 0; y < bs; y++)
        for (let x = 0; x < bs; x++) {
          const X = Math.min(bx * bs + x, W - 1), Y = Math.min(by * bs + y, H - 1);
          for (let k = 0; k < 3; k++) px[n * 3 + k] = img.data[(Y * W + X) * 3 + k];
          pos.push(bx * bs + x < W && by * bs + y < H ? Y * W + X : -1);
          n++;
        }
      // 平均と主軸（べき乗法）
      const m = [0, 0, 0];
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) m[k] += px[i * 3 + k] / n;
      const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a * 3 + b] += (px[i * 3 + a] - m[a]) * (px[i * 3 + b] - m[b]);
      let ax = [1, 1, 1];
      for (let it = 0; it < 8; it++) {
        const v = [0, 1, 2].map(a => cov[a * 3] * ax[0] + cov[a * 3 + 1] * ax[1] + cov[a * 3 + 2] * ax[2]);
        const len = Math.hypot(...v) || 1;
        ax = v.map(t => t / len);
      }
      let tmin = Infinity, tmax = -Infinity;
      for (let i = 0; i < n; i++) {
        const t = (px[i * 3] - m[0]) * ax[0] + (px[i * 3 + 1] - m[1]) * ax[1] + (px[i * 3 + 2] - m[2]) * ax[2];
        if (t < tmin) tmin = t; if (t > tmax) tmax = t;
      }
      let e0 = m.map((v, k) => v + tmin * ax[k]), e1 = m.map((v, k) => v + tmax * ax[k]);
      let best = null, bestErr = Infinity;
      for (let it = 0; it < 4; it++) {
        const q0 = quantEp(e0, p.ep), q1 = quantEp(e1, p.ep);
        const pal = [];
        for (let l = 0; l < L; l++) pal.push([0, 1, 2].map(k => q0[k] + (q1[k] - q0[k]) * l / (L - 1)));
        let err = 0;
        for (let i = 0; i < n; i++) {
          let bl = 0, be = Infinity;
          for (let l = 0; l < L; l++) {
            const dr = px[i * 3] - pal[l][0], dg = px[i * 3 + 1] - pal[l][1], db = px[i * 3 + 2] - pal[l][2];
            const e = dr * dr + dg * dg + db * db;
            if (e < be) { be = e; bl = l; }
          }
          idx[i] = bl; err += be;
        }
        if (err < bestErr) { bestErr = err; best = { pal, idx: Int32Array.from(idx) }; }
        // 端点を最小二乗で当て直す: p ≈ (1-w) a + w b
        let s00 = 0, s01 = 0, s11 = 0;
        const r0 = [0, 0, 0], r1 = [0, 0, 0];
        for (let i = 0; i < n; i++) {
          const w = idx[i] / (L - 1), u = 1 - w;
          s00 += u * u; s01 += u * w; s11 += w * w;
          for (let k = 0; k < 3; k++) { r0[k] += u * px[i * 3 + k]; r1[k] += w * px[i * 3 + k]; }
        }
        const det = s00 * s11 - s01 * s01;
        if (Math.abs(det) < 1e-9) break;
        e0 = [0, 1, 2].map(k => (s11 * r0[k] - s01 * r1[k]) / det);
        e1 = [0, 1, 2].map(k => (s00 * r1[k] - s01 * r0[k]) / det);
      }
      for (let i = 0; i < n; i++) if (pos[i] >= 0) for (let k = 0; k < 3; k++) rec.data[pos[i] * 3 + k] = best.pal[best.idx[i]][k];
    }
  const epBits = 2 * (p.ep[0] + p.ep[1] + p.ep[2]);
  return { bits: nbx * nby * (epBits + bs * bs * p.ib), rec };
}

// ======================================================================================
// 3. パレット + 添字（画像全体で 1 つのパレット）。ディザは Floyd-Steinberg
// ======================================================================================
function paletteCodec(img, p) {
  const n = img.w * img.h, P = p.P;
  const sampleN = Math.min(n, 30000);
  const sample = new Float64Array(sampleN * 3);
  for (let i = 0; i < sampleN; i++) {
    const j = Math.floor((i + 0.5) * n / sampleN);
    for (let k = 0; k < 3; k++) sample[i * 3 + k] = img.data[j * 3 + k];
  }
  const { C: cb } = C.kmeans(sample, sampleN, 3, P, 12, 7);
  const pal = new Float64Array(P * 3);
  for (let i = 0; i < P * 3; i++) pal[i] = qlev(cb[i], 8);
  const nearest = (r, g, b) => {
    let best = 0, be = Infinity;
    for (let c = 0; c < P; c++) {
      const dr = r - pal[c * 3], dg = g - pal[c * 3 + 1], db = b - pal[c * 3 + 2];
      const e = dr * dr + dg * dg + db * db;
      if (e < be) { be = e; best = c; }
    }
    return best;
  };
  const rec = I.create(img.w, img.h, 3);
  const work = Float64Array.from(img.data);
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const i = y * img.w + x;
      const c = nearest(work[i * 3], work[i * 3 + 1], work[i * 3 + 2]);
      for (let k = 0; k < 3; k++) {
        rec.data[i * 3 + k] = pal[c * 3 + k];
        if (p.dither) {
          const e = work[i * 3 + k] - pal[c * 3 + k];
          if (x + 1 < img.w) work[(i + 1) * 3 + k] += e * 7 / 16;
          if (y + 1 < img.h) {
            if (x > 0) work[(i + img.w - 1) * 3 + k] += e * 3 / 16;
            work[(i + img.w) * 3 + k] += e * 5 / 16;
            if (x + 1 < img.w) work[(i + img.w + 1) * 3 + k] += e * 1 / 16;
          }
        }
      }
    }
  return { bits: n * log2c(P) + P * 24, rec };
}

// ======================================================================================
// 4. 差分・予測（DPCM）。YCbCr 4:2:0、MED 予測、量子化幅 q の準可逆。
//    vlc: 適応 Rice ＋ 平坦部のラン（JPEG-LS 風）。タイル（T×T）ごとに独立で、タイル先頭の位置（24 bit）を持つ
//    fix: 残差を b bit の固定長に切り詰める（ランダムアクセス可能）
// ======================================================================================
function egLen(v, k) { const x = v + (1 << k); return 2 * (32 - Math.clz32(x)) - 1 - k; }

function dpcmPlane(pl, q, mode, b, T) {
  const W = pl.w, H = pl.h, src = pl.data, out = new Float64Array(W * H);
  let bits = 0;
  const maxR = b ? (1 << (b - 1)) - 1 : 0;
  for (let ty = 0; ty < H; ty += T)
    for (let tx = 0; tx < W; tx += T) {
      if (mode === 'vlc') bits += 24;
      let A = 4 * q, N = 1; // Rice の適応状態（タイルごとに初期化）
      let run = 0;
      const flushRun = () => { if (run > 0) { bits += egLen(run - 1, 1); run = 0; } };
      for (let y = ty; y < Math.min(ty + T, H); y++)
        for (let x = tx; x < Math.min(tx + T, W); x++) {
          const hasA = x > tx, hasB = y > ty;
          const a = hasA ? out[y * W + x - 1] : hasB ? out[(y - 1) * W + x] : 128;
          const bb = hasB ? out[(y - 1) * W + x] : a;
          const c = hasA && hasB ? out[(y - 1) * W + x - 1] : a;
          let pred = c >= Math.max(a, bb) ? Math.min(a, bb) : c <= Math.min(a, bb) ? Math.max(a, bb) : a + bb - c;
          const e = src[y * W + x] - pred;
          let r = Math.round(e / q);
          if (mode === 'fix') r = Math.max(-maxR - 1, Math.min(maxR, r));
          out[y * W + x] = clamp(pred + r * q);
          if (mode === 'fix') { bits += b; continue; }
          // 平坦（近傍が揃っている）ならラン符号: 0 の連続を数え、途切れたら長さを書く
          const flat = hasA && hasB && Math.abs(a - bb) < q / 2 && Math.abs(a - c) < q / 2;
          if (flat && r === 0) { run++; continue; }
          if (flat) { flushRun(); bits += 1; } // ランの終わりの印
          else flushRun();
          const u = r >= 0 ? 2 * r : -2 * r - 1;
          let k = 0; while ((N << k) < A && k < 15) k++;
          bits += (u >> k) + 1 + k;
          A += Math.abs(r) * q; N++;
          if (N >= 64) { A >>= 1; N >>= 1; }
        }
      flushRun();
    }
  return { bits, out };
}

function dpcmCodec(img, p) {
  const [Y, Cb, Cr] = C.toPlanes(img);
  const w2 = Math.ceil(img.w / 2), h2 = Math.ceil(img.h / 2);
  const planes = [Y, I.resize(Cb, w2, h2), I.resize(Cr, w2, h2)];
  let bits = 0;
  const recs = planes.map((pl, k) => {
    const r = dpcmPlane(pl, k ? p.q * p.cq : p.q, p.mode, k ? p.cb : p.yb, p.T || 32);
    bits += r.bits;
    return { w: pl.w, h: pl.h, c: 1, data: r.out };
  });
  const rec = C.fromPlanes(recs[0], I.resizeBilinear(recs[1], img.w, img.h), I.resizeBilinear(recs[2], img.w, img.h));
  return { bits, rec };
}

// ======================================================================================
// 5. DCT（JPEG 風、4:2:0）
//    dctv: ブロック独立の可変長。JPEG と同じ (ラン, 大きさ) 記号を画像ごとの最適ハフマンで数える（表の費用も数える）。
//          DC はセグメント（S ブロック）の中だけで差分。セグメント先頭の位置を 24 bit ずつ持つ
//    dctf: 係数の位置ごとに固定幅（画像全体の最大値から決める）。ランダムアクセスでき、シェーダーが最も楽
//    jpeg: 参考として jpeg-js（ベースライン、4:4:4、標準ハフマン表）のファイルの大きさ
// ======================================================================================
function qScale(quality) { return quality < 50 ? 5000 / quality : 200 - 2 * quality; }
function qTables(quality) {
  const s = qScale(quality);
  const mk = t => t.map(v => Math.max(1, Math.min(255, Math.floor((v * s + 50) / 100))));
  return [mk(D.QY), mk(D.QC)];
}

function planeBlocks(pl) {
  const bw = Math.ceil(pl.w / 8), bh = Math.ceil(pl.h / 8);
  const blocks = [];
  const blk = new Float64Array(64);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const X = Math.min(bx * 8 + x, pl.w - 1), Y = Math.min(by * 8 + y, pl.h - 1);
        blk[y * 8 + x] = pl.data[Y * pl.w + X] - 128;
      }
      blocks.push(D.fdct(blk, new Float64Array(64)));
    }
  return { bw, bh, blocks };
}

function blocksToPlane(w, h, bw, coefs) {
  const out = { w, h, c: 1, data: new Float64Array(w * h) };
  const tmp = new Float64Array(64);
  coefs.forEach((cf, b) => {
    const bx = b % bw, by = Math.floor(b / bw);
    D.idct(cf, tmp);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const X = bx * 8 + x, Y = by * 8 + y;
      if (X < w && Y < h) out.data[Y * w + X] = tmp[y * 8 + x] + 128;
    }
  });
  return out;
}

function huffLengths(freq) {
  // 頻度からハフマン符号長を求める（上限なし）。表の費用は記号数 × 12 bit で近似
  const syms = [...freq.entries()].filter(([, f]) => f > 0);
  const depth = new Map(syms.map(([s]) => [s, 1]));
  if (syms.length > 1) {
    for (const s of depth.keys()) depth.set(s, 0);
    let nodes = syms.map(([s, f]) => ({ f, leaves: [s] }));
    while (nodes.length > 1) {
      nodes.sort((a, b) => a.f - b.f);
      const [a, b] = nodes.splice(0, 2);
      for (const s of a.leaves.concat(b.leaves)) depth.set(s, depth.get(s) + 1);
      nodes.push({ f: a.f + b.f, leaves: a.leaves.concat(b.leaves) });
    }
  }
  let total = 0;
  for (const [s, f] of syms) total += f * depth.get(s);
  const maxD = Math.max(1, ...depth.values());
  return { total, table: syms.length * 12, len: s => depth.get(s) ?? maxD + 1 };
}

const bitSize = v => (v === 0 ? 0 : 32 - Math.clz32(Math.abs(v)));

// ブロックの記号列（JPEG と同じ: DC は差分の大きさ、AC は (ラン, 大きさ)、EOB・ZRL）
function blockSymbols(q, prevDC) {
  const dd = q[0] - prevDC;
  const dc = bitSize(dd);
  const ac = [];
  let extra = dc, run = 0, lastNZ = 0;
  for (let k = 63; k >= 1; k--) if (q[D.ZIGZAG[k]] !== 0) { lastNZ = k; break; }
  for (let k = 1; k <= lastNZ; k++) {
    const v = q[D.ZIGZAG[k]];
    if (v === 0) { run++; if (run === 16) { ac.push(0xf0); run = 0; } continue; }
    const sz = bitSize(v);
    ac.push((run << 4) | sz); extra += sz; run = 0;
  }
  if (lastNZ < 63) ac.push(0);
  return { dc, ac, extra };
}

// 可変長のブロックを転送層のチャンクに詰める: ブロックはチャンクをまたがない。チャンクの頭に
// 「最初のブロック番号」（hdr bit）を置き、DC の差分はチャンクの先頭で途切れる。
function packIntoChunks(sizes, hdr) {
  const cap = C.CHUNK_BITS - hdr;
  let chunks = 0, used = cap + 1;
  for (const s of sizes) {
    if (s > cap) throw new Error('block larger than a chunk');
    if (used + s > cap) { chunks++; used = 0; }
    used += s;
  }
  return chunks;
}

function dctCodec(img, p) {
  const [Y, Cb, Cr] = C.toPlanes(img);
  const w2 = Math.ceil(img.w / 2), h2 = Math.ceil(img.h / 2);
  const full = p.chroma === 444; // 4:4:4 なら色差も等倍
  const planes = full ? [Y, Cb, Cr] : [Y, I.resize(Cb, w2, h2), I.resize(Cr, w2, h2)];
  const [QY, QC] = qTables(p.quality);
  const recPlanes = [], all = []; // all: { t, q }（輝度 t=0、色差 t=1）
  let bits = 0;
  planes.forEach((pl, ch) => {
    const qt = ch ? QC : QY;
    const { bw, blocks } = planeBlocks(pl);
    const qblocks = blocks.map(cf => { const q = new Int32Array(64); for (let k = 0; k < 64; k++) q[k] = Math.round(cf[k] / qt[k]); return q; });
    for (const q of qblocks) all.push({ t: ch ? 1 : 0, q });
    if (p.mode === 'dctf') {
      // 位置ごとの固定幅（符号付き）。幅は 64 個を 4 bit ずつ見出しに持つ
      const wk = new Int32Array(64);
      for (let k = 0; k < 64; k++) {
        let mx = 0;
        for (const q of qblocks) mx = Math.max(mx, Math.abs(q[k]));
        wk[k] = mx === 0 ? 0 : bitSize(mx) + 1;
      }
      bits += qblocks.length * wk.reduce((a, b) => a + b, 0) + 64 * 4;
    }
    const deq = qblocks.map(q => { const c = new Float64Array(64); for (let k = 0; k < 64; k++) c[k] = q[k] * qt[k]; return c; });
    recPlanes.push(blocksToPlane(pl.w, pl.h, bw, deq));
  });
  if (p.mode === 'dctv' || p.mode === 'dctc') {
    // 1 回目: 全ブロックを差分つきで記号化して表を作る
    const fDC = [new Map(), new Map()], fAC = [new Map(), new Map()];
    let prev = [0, 0, 0], pch = -1;
    const S = p.S || 16;
    const syms = all.map(({ t, q }, i) => {
      const s = blockSymbols(q, (p.mode === 'dctv' && i % S === 0) ? 0 : prev[t]);
      prev[t] = q[0];
      fDC[t].set(s.dc, (fDC[t].get(s.dc) || 0) + 1);
      for (const a of s.ac) fAC[t].set(a, (fAC[t].get(a) || 0) + 1);
      return s;
    });
    const H = [0, 1].map(t => ({ dc: huffLengths(fDC[t]), ac: huffLengths(fAC[t]) }));
    const tables = H.reduce((a, h) => a + h.dc.table + h.ac.table, 0);
    const size = (s, t) => H[t].dc.len(s.dc) + s.ac.reduce((a, x) => a + H[t].ac.len(x), 0) + s.extra;
    if (p.mode === 'dctv') {
      bits = syms.reduce((a, s, i) => a + size(s, all[i].t), 0) + tables + Math.ceil(all.length / S) * 24;
    } else {
      // チャンクの先頭のブロックは DC を差分でなく絶対値で書く（大きさを数え直す）
      const hdr = 17;
      const sizes = [];
      const cap = C.CHUNK_BITS - hdr;
      let used = cap + 1, chunks = 0;
      prev = [0, 0, 0];
      all.forEach(({ t, q }, i) => {
        let s = size(syms[i], t);
        if (used + s > cap) {
          chunks++; used = 0;
          s = size(blockSymbols(q, 0), t);
        }
        used += s; prev[t] = q[0];
      });
      bits = chunks * C.CHUNK_BITS + tables;
    }
  }
  const upc = pl => (pl.w === img.w && pl.h === img.h ? pl : I.resizeBilinear(pl, img.w, img.h));
  const rec = C.fromPlanes(recPlanes[0], upc(recPlanes[1]), upc(recPlanes[2]));
  return { bits, rec };
}

function jpegRef(img, p) {
  const data = Buffer.alloc(img.w * img.h * 4);
  for (let i = 0; i < img.w * img.h; i++) { for (let k = 0; k < 3; k++) data[i * 4 + k] = clamp(Math.round(img.data[i * 3 + k])); data[i * 4 + 3] = 255; }
  const enc = jpeg.encode({ data, width: img.w, height: img.h }, p.quality).data;
  const dec = jpeg.decode(enc, { useTArray: true });
  const rec = I.create(img.w, img.h, 3);
  for (let i = 0; i < img.w * img.h; i++) for (let k = 0; k < 3; k++) rec.data[i * 3 + k] = dec.data[i * 4 + k];
  return { bits: enc.length * 8, rec };
}

// ======================================================================================
// 6. ウェーブレット（CDF 9/7、Y 5 段・色差 4:2:0 で 4 段）。帯域ごとに合成基底のノルムで割った一様デッドゾーン量子化。
//    符号化は 32×32 のコードブロックごとに独立（先頭の位置 24 bit）: 0 のランを EG(kz)、非 0 を Rice(k)＋符号。
//    k・kz はブロックごとに最良を選ぶ（6 bit）
// ======================================================================================
const A1 = -1.586134342, A2 = -0.05298011854, A3 = 0.8829110762, A4 = 0.4435068522, KS = 1.149604398;
function fwd1d(x, n) {
  if (n < 2) return;
  const at = i => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
  for (let i = 1; i < n; i += 2) x[i] += A1 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 0; i < n; i += 2) x[i] += A2 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 1; i < n; i += 2) x[i] += A3 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 0; i < n; i += 2) x[i] += A4 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 0; i < n; i++) x[i] = i % 2 ? x[i] / KS : x[i] * KS;
  const t = Float64Array.from(x.subarray(0, n)), h = (n + 1) >> 1;
  for (let i = 0; i < n; i++) x[i % 2 ? h + (i >> 1) : i >> 1] = t[i];
}
function inv1d(x, n) {
  if (n < 2) return;
  const t = Float64Array.from(x.subarray(0, n)), h = (n + 1) >> 1;
  for (let i = 0; i < n; i++) x[i] = t[i % 2 ? h + (i >> 1) : i >> 1];
  const at = i => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
  for (let i = 0; i < n; i++) x[i] = i % 2 ? x[i] * KS : x[i] / KS;
  for (let i = 0; i < n; i += 2) x[i] -= A4 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 1; i < n; i += 2) x[i] -= A3 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 0; i < n; i += 2) x[i] -= A2 * (x[at(i - 1)] + x[at(i + 1)]);
  for (let i = 1; i < n; i += 2) x[i] -= A1 * (x[at(i - 1)] + x[at(i + 1)]);
}
function dwt2(d, W, H, levels, inverse) {
  const sizes = [];
  let w = W, h = H;
  for (let l = 0; l < levels; l++) { sizes.push([w, h]); w = (w + 1) >> 1; h = (h + 1) >> 1; }
  const row = new Float64Array(Math.max(W, H));
  const order = inverse ? sizes.slice().reverse() : sizes;
  for (const [w, h] of order) {
    const doRows = () => { for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) row[x] = d[y * W + x]; (inverse ? inv1d : fwd1d)(row, w); for (let x = 0; x < w; x++) d[y * W + x] = row[x]; } };
    const doCols = () => { for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) row[y] = d[y * W + x]; (inverse ? inv1d : fwd1d)(row, h); for (let y = 0; y < h; y++) d[y * W + x] = row[y]; } };
    if (inverse) { doCols(); doRows(); } else { doRows(); doCols(); }
  }
  return sizes;
}
// 帯域の一覧（領域と段）。sizes[l] = その段で変換した領域の大きさ
function subbandsOf(W, H, levels) {
  const out = [];
  let w = W, h = H;
  for (let l = 0; l < levels; l++) {
    const lw = (w + 1) >> 1, lh = (h + 1) >> 1;
    out.push({ l, o: 'HL', x0: lw, y0: 0, x1: w, y1: lh });
    out.push({ l, o: 'LH', x0: 0, y0: lh, x1: lw, y1: h });
    out.push({ l, o: 'HH', x0: lw, y0: lh, x1: w, y1: h });
    w = lw; h = lh;
  }
  out.push({ l: levels, o: 'LL', x0: 0, y0: 0, x1: w, y1: h });
  return out;
}
const normCache = new Map();
function subbandNorm(level, orient, levels) {
  // 合成基底のノルム（大きな領域で単位インパルスを逆変換して測る）
  const key = levels + ":" + level + orient;
  if (normCache.has(key)) return normCache.get(key);
  const S = 256, L = levels, d = new Float64Array(S * S);
  const sb = subbandsOf(S, S, L).find(b => b.l === level && b.o === orient);
  const cx = (sb.x0 + sb.x1) >> 1, cy = (sb.y0 + sb.y1) >> 1;
  d[cy * S + cx] = 1;
  dwt2(d, S, S, L, true);
  let s = 0; for (const v of d) s += v * v;
  normCache.set(key, Math.sqrt(s));
  return Math.sqrt(s);
}

function wavPlane(pl, levels, step, dz) {
  const W = pl.w, H = pl.h;
  const d = Float64Array.from(pl.data, v => v - 128);
  dwt2(d, W, H, levels, false);
  let bits = 0;
  const q = new Int32Array(W * H);
  for (const sb of subbandsOf(W, H, levels)) {
    const D = step / subbandNorm(sb.l, sb.o, levels);
    for (let y = sb.y0; y < sb.y1; y++)
      for (let x = sb.x0; x < sb.x1; x++) {
        const v = d[y * W + x], a = Math.abs(v) / D;
        const m = Math.floor(a + 0.5 - dz);
        q[y * W + x] = m > 0 ? (v < 0 ? -m : m) : 0;
        d[y * W + x] = m > 0 ? Math.sign(v) * (m + dz * 0.5) * D : 0; // 復元は区間の中ほどへ少し寄せる
      }
    // コードブロック 32×32 ごと
    for (let by = sb.y0; by < sb.y1; by += 32)
      for (let bx = sb.x0; bx < sb.x1; bx += 32) {
        const vals = [];
        for (let y = by; y < Math.min(by + 32, sb.y1); y++) for (let x = bx; x < Math.min(bx + 32, sb.x1); x++) vals.push(q[y * W + x]);
        if (vals.every(v => v === 0)) { bits += 1 + 24 / 8; continue; } // 空ブロックの印（位置表は 3 bit 相当に圧縮できるとみなす）
        let best = Infinity;
        for (let k = 0; k < 8; k++)
          for (let kz = 0; kz < 8; kz++) {
            let b = 0, run = 0;
            for (const v of vals) {
              if (v === 0) { run++; continue; }
              b += egLen(run, kz); run = 0;
              const u = Math.abs(v) - 1;
              b += (u >> k) + 1 + k + 1;
            }
            b += egLen(run, kz);
            if (b < best) best = b;
          }
        bits += best + 6 + 24;
      }
  }
  dwt2(d, W, H, levels, true);
  return { bits, out: { w: W, h: H, c: 1, data: Float64Array.from(d, v => v + 128) } };
}

function waveletCodec(img, p) {
  const [Y, Cb, Cr] = C.toPlanes(img);
  const w2 = Math.ceil(img.w / 2), h2 = Math.ceil(img.h / 2);
  const ry = wavPlane(Y, 5, p.step, 0.2);
  const full = p.chroma === 444;
  const rcb = full ? wavPlane(Cb, 5, p.step * p.cq, 0.2) : wavPlane(I.resize(Cb, w2, h2), 4, p.step * p.cq, 0.2);
  const rcr = full ? wavPlane(Cr, 5, p.step * p.cq, 0.2) : wavPlane(I.resize(Cr, w2, h2), 4, p.step * p.cq, 0.2);
  const upc = pl => (pl.w === img.w && pl.h === img.h ? pl : I.resizeBilinear(pl, img.w, img.h));
  const rec = C.fromPlanes(ry.out, upc(rcb.out), upc(rcr.out));
  return { bits: ry.bits + rcb.bits + rcr.bits, rec };
}

// ======================================================================================
// 7. VQ（4×4 RGB ブロック、画像ごとに学習したコードブック。コードブックも送る: 1 要素 8 bit）
// ======================================================================================
function vqCodec(img, p) {
  const bs = 4, nbx = Math.ceil(img.w / bs), nby = Math.ceil(img.h / bs), n = nbx * nby, d = bs * bs * 3;
  const all = new Float64Array(n * d);
  for (let b = 0; b < n; b++) {
    const bx = b % nbx, by = Math.floor(b / nbx);
    let j = 0;
    for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) {
      const X = Math.min(bx * bs + x, img.w - 1), Y = Math.min(by * bs + y, img.h - 1);
      for (let k = 0; k < 3; k++) all[b * d + j++] = img.data[(Y * img.w + X) * 3 + k];
    }
  }
  const sN = Math.min(n, 12000), sample = new Float64Array(sN * d);
  for (let i = 0; i < sN; i++) { const b = Math.floor((i + 0.5) * n / sN); sample.set(all.subarray(b * d, b * d + d), i * d); }
  const { C: cb } = C.kmeans(sample, sN, d, p.K, 8, 3);
  for (let i = 0; i < cb.length; i++) cb[i] = qlev(cb[i], 8);
  const rec = I.create(img.w, img.h, 3);
  for (let b = 0; b < n; b++) {
    let best = 0, be = Infinity;
    for (let c = 0; c < p.K; c++) {
      let e = 0;
      for (let j = 0; j < d && e < be; j++) { const t = all[b * d + j] - cb[c * d + j]; e += t * t; }
      if (e < be) { be = e; best = c; }
    }
    const bx = b % nbx, by = Math.floor(b / nbx);
    let j = 0;
    for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) {
      const X = bx * bs + x, Y = by * bs + y;
      for (let k = 0; k < 3; k++, j++) if (X < img.w && Y < img.h) rec.data[(Y * img.w + X) * 3 + k] = cb[best * d + j];
    }
  }
  return { bits: n * log2c(p.K) + p.K * d * 8, rec };
}

// ======================================================================================
// 方式の一覧（レートを動かす軸を含む格子）
// ======================================================================================
const SCALES = [1, 0.875, 0.75, 0.625, 0.5, 0.375];

const CODECS = {
  // raw
  'raw-rgb888': { fam: 'raw', grid: SCALES.map(s => ({ s, bits: [8, 8, 8] })), run: rawRGB },
  'raw-rgb565': { fam: 'raw', grid: SCALES.map(s => ({ s, bits: [5, 6, 5] })), run: rawRGB },
  'raw-rgb444': { fam: 'raw', grid: SCALES.map(s => ({ s, bits: [4, 4, 4] })), run: rawRGB },
  'raw-ycc420-8.8': { fam: 'raw', grid: SCALES.map(s => ({ s, yb: 8, cb: 8 })), run: rawYcc },
  'raw-ycc420-6.5': { fam: 'raw', grid: SCALES.map(s => ({ s, yb: 6, cb: 5 })), run: rawYcc },
  // block
  'bc1 (4x4,565,2bit=4bpp)': { fam: 'block', grid: SCALES.map(s => ({ s, bs: 4, ep: [5, 6, 5], ib: 2 })), run: blockCodec },
  'btc-c (4x4,565,1bit=3bpp)': { fam: 'block', grid: SCALES.map(s => ({ s, bs: 4, ep: [5, 6, 5], ib: 1 })), run: blockCodec },
  'blk (4x4,888,3bit=6bpp)': { fam: 'block', grid: SCALES.map(s => ({ s, bs: 4, ep: [8, 8, 8], ib: 3 })), run: blockCodec },
  'blk (4x4,888,4bit=7bpp)': { fam: 'block', grid: SCALES.map(s => ({ s, bs: 4, ep: [8, 8, 8], ib: 4 })), run: blockCodec },
  'blk (8x8,565,2bit=2.5bpp)': { fam: 'block', grid: SCALES.map(s => ({ s, bs: 8, ep: [5, 6, 5], ib: 2 })), run: blockCodec },
  'blk (8x8,565,3bit=3.5bpp)': { fam: 'block', grid: SCALES.map(s => ({ s, bs: 8, ep: [5, 6, 5], ib: 3 })), run: blockCodec },
  // palette
  'pal-global': { fam: 'palette', grid: [16, 32, 64, 128, 256].flatMap(P => [1, 0.75, 0.5].map(s => ({ s, P, dither: 0 }))), run: paletteCodec },
  'pal-global-dither': { fam: 'palette', grid: [16, 32, 64, 128, 256].flatMap(P => [1, 0.75, 0.5].map(s => ({ s, P, dither: 1 }))), run: paletteCodec },
  // DPCM
  'dpcm-vlc': { fam: 'dpcm', grid: [1, 2, 3, 4, 6, 8, 11, 15, 20].map(q => ({ s: 1, q, cq: 1.5, mode: 'vlc', T: 32 })), run: dpcmCodec },
  'dpcm-fix': { fam: 'dpcm', grid: [[2, 3], [3, 3], [4, 3], [4, 4], [5, 4], [6, 5]].flatMap(([b, cbb]) => [2, 4, 8, 12].map(q => ({ s: 1, q, cq: 1.5, mode: 'fix', yb: b, cb: cbb }))), run: dpcmCodec },
  // DCT
  'dctv (seg16)': { fam: 'dct', grid: [5, 10, 20, 30, 40, 50, 60, 70, 80, 85, 90, 93, 95, 97, 98, 99].map(quality => ({ s: 1, quality, mode: 'dctv', S: 16 })), run: dctCodec },
  'dctc (chunk-packed)': { fam: 'dct', grid: [5, 10, 20, 30, 40, 50, 60, 70, 80, 85, 90, 93, 95, 97, 98, 99].map(quality => ({ s: 1, quality, mode: 'dctc' })), run: dctCodec },
  'dctc (chunk-packed, 4:4:4)': { fam: 'dct', grid: [5, 10, 20, 30, 40, 50, 60, 70, 80, 85, 90, 93, 95, 97, 98, 99].map(quality => ({ s: 1, quality, mode: 'dctc', chroma: 444 })), run: dctCodec },
  'dctf (fixed)': { fam: 'dct', grid: [5, 10, 20, 30, 40, 50, 60, 70, 80, 85, 90, 93, 95, 97, 98, 99].map(quality => ({ s: 1, quality, mode: 'dctf' })), run: dctCodec },
  'jpeg (ref 4:4:4 std)': { fam: 'dct', grid: [5, 10, 20, 30, 40, 50, 60, 70, 80, 85, 90, 93, 95, 97, 98, 99].map(quality => ({ s: 1, quality })), run: jpegRef },
  // wavelet
  'wavelet97': { fam: 'wavelet', grid: [60, 40, 28, 20, 14, 10, 7, 5, 3.5, 2.5, 1.7, 1.2, 0.8, 0.5].map(step => ({ s: 1, step, cq: 1.5 })), run: waveletCodec },
  'wavelet97 (4:4:4)': { fam: 'wavelet', grid: [60, 40, 28, 20, 14, 10, 7, 5, 3.5, 2.5, 1.7, 1.2, 0.8, 0.5].map(step => ({ s: 1, step, cq: 1.5, chroma: 444 })), run: waveletCodec },
  // VQ
  'vq4x4': { fam: 'vq', grid: [256, 1024].flatMap(K => [1, 0.75].map(s => ({ s, K }))), run: vqCodec },
};

// scaled() は fn の戻り値の rec を拡大するので、run の戻りをそのまま渡す
function run(name, p, img) {
  const c = CODECS[name];
  const t0 = Date.now();
  const r = C.scaled(img, p.s || 1, x => c.run(x, p));
  return { bits: r.bits, rec: r.rec, ms: Date.now() - t0 };
}

module.exports = { CODECS, run, _: { blockCodec, dctCodec, waveletCodec, paletteCodec, dpcmCodec, rawRGB, rawYcc, vqCodec, jpegRef } };
