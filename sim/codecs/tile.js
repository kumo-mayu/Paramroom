'use strict';
// TILE: tile-adaptive hybrid = per-tile BASE (none / local palette [/ flat colour]) + one global layered
// wavelet stream (wavl machinery) that codes the RESIDUAL (image - base) over the whole image.
//
// Why additive (base + residual everywhere) instead of "tile shows either its palette or the wavelet":
//  * one wavelet stream, one inverse DWT, no special handling of coefficients whose support straddles
//    tiles of different modes: the encoder codes ref - base, so the full decode is never limited by the
//    base (a PALETTE tile with anti-aliased text still converges towards the original);
//  * residual coefficients in tiles whose base already fits are ~0 and cost nothing; the rest are RD ranked.
// MEAN-FREE base (cfg.mf, default): a tile's base offset is (palette render - its own tile mean), so tile
// means / low frequencies always stay in the wavelet stream. Reason: with an absolute base (mf:false,
// which also enables FLAT tiles) a single lost base packet (~7% slot loss at bm14) leaves the whole tile
// grey for a full carousel cycle because the residual was coded against it (measured: screenshot_wikipedia
// B256 msssimc@10s 0.75 vs 0.92 for wavl). Mean-free: a missing palette only loses the tile's texture.
// FLAT mode is meaningless when mean-free (offset 0 == WAV), so it only exists for mf:false.
//
// Tile modes (T x T tiles, T = 16/32/64; nT = 256/T per side, tb = log2(nT^2) bits per tile id):
//   WAV  : base offset 0 (plain wavelet, like wavl)
//   PAL  : local palette K in {2,4} (RGB565 each) + per-pixel index at res 1 (T x T) or res 2
//          (T/2 x T/2, nearest upsampled); index 0 = most frequent colour.
//   FLAT : one RGB565 colour (absolute-base variant only)
//
// Packet formats (P payload bits, MSB first, zero padded; every packet self-describing):
//   '0'  WAV  : packet-coder run (as wavl) of the layered residual coefficients, cap P-1:
//               [group id][aligned index][DPCM/SEG or zero-run EG + level SEG symbols...]
//   '10' PAL  : segment { [tile (tb)] [K==4 (1)] [res==2 (1)] [kind (1)] body } ['1' segment]...
//               kind 1 (palette): [first entry e0 (2)] entries e0.. (16 each, while they fit, < K);
//                                 if the entries reach K and bits remain: index runs from pixel 0
//               kind 0 (indices): [start pixel (log2 npix)] index runs
//               index runs: [EG order k (2)] [first symbol (log2 K)] then runs EG_k(len-1); before every
//               run after the first a symbol change: K=2 implicit flip, K=4 '0'|'1x' = offset 1..3 from
//               the previous symbol. Raster order in the tile's index grid; the last run may be truncated
//               at the packet end (the next packet restates the symbol). When a segment's runs complete
//               the tile, a '1' bit may start another tile's segment in the same packet (saves ~14% of
//               the palette packets); padding zeros = stop. Positions are written only after a run is
//               fully read, so padding (zeros never terminate an EG code) writes nothing.
//   '11' FLAT : [count-1 (tb)] count x ( [tile (tb)] [RGB565 (16)] )     (mf:false only)
//   MODE MAP: signalled implicitly - every PAL/FLAT segment names its tile and mode (K,res). A tile with
//   no such segment renders as WAV. An explicit 2-bit/tile map was dropped on purpose: with the additive
//   mean-free design an unknown-mode tile and a PAL tile whose palette is missing render identically
//   (wavelet only), so the map would cost 1..8 packets with no render difference. Missing palette
//   entries -> entry 0 (no base if entry 0 is missing), missing index -> 0 (background colour).
//   All writes are idempotent overwrites at explicit addresses => any subset/order/duplicates = same render.
//
// Encoder (RD, ~2 s T64, ~4-5 s T32, ~15 s T16 per image at B256):
//   D = SSE in YCbCr with wavl's channel weights (~RGB SSE/3), no SSIM weighting. Residual distortion is
//   measured in the norm-weighted wavelet COEFFICIENT domain (same domain as the coefficient gains; the
//   9/7 basis is not orthogonal, mixing pixel-domain D with coefficient gains made PAL look ~2x too good).
//   lambda = marginal gain/bit at R = tgt/0.14*P bits (cfg.tgt seconds), from sorting coefficient
//   (gain, estimated EG bits x packet header overhead) and tile base items by gain/bit.
//   For each candidate mode m (WAV, PAL K2/K4 x res1/res2) a base with EVERY tile in mode m is coded and
//   J_t(m) = Dcoef_t(residual) - sum_{coefs centred in t} max(0, gain - lambda*bits) + lambda*baseBits_t;
//   modes = argmin_m (2 rounds re-estimating lambda); fallback to all-WAV if its total J is lower; then a
//   greedy pass re-evaluates the whole-image J for the 2 best alternatives of every tile (seam effects).
//   Units ordered globally by gain per packet: WAV runs by summed coefficient gain; PAL packets (tiles
//   in gain/bit order) by exact prefix gains from a simulated decoder, made non-increasing with
//   pool-adjacent-violators (a tile's palette never trails its indices).
//   tgt trades early vs late quality: low tgt -> few PAL tiles (early ~= wavl), high tgt -> many PAL tiles
//   (better at 20-60 s on screenshots, worse at 2-10 s because PAL tiles are all-or-nothing chains).
//
// Shader state / cost:
//   * wavelet: exactly wavl (layer coefficient textures 256^2 x 3 + inverse 9/7 synthesis passes).
//   * tile table (nT x nT texels): K/res flags + 4 palette colours (+ flat) + tile base mean
//     (the mean is recomputed after palette/index writes, e.g. a mip of the base texture: T=32 -> level 5).
//   * index texture 256 x 256 R8 (res-2 tiles use their T/2 grid, nearest).
//   * apply: palette = texel writes; index segment = one pass over the tile's npix texels, each finding
//     its run by scanning the packet's runs (<= ~P/2 iterations) - same VLC-in-shader class as wavl.
//   * render per pixel: tile table fetch + index fetch + palette lookup - mean, to YCbCr (linear),
//     add the 3 wavelet planes (+128), back to RGB. ~4 fetches on top of wavl's synthesis.
const { BitWriter, BitReader } = require('../lib/bits');
const I = require('../lib/image');
const PC = require('./packet-coder');
const W = require('./wav')._internal;
const WL = require('./wavl')._internal;
const { trainingImages } = require('./training');

const SIZE = 256;
const CH_W = [1, (0.344136 ** 2 + 1.772 ** 2) / 3, (1.402 ** 2 + 0.714136 ** 2) / 3];
const M_WAV = 0, M_FLAT = 1, M_PAL = 2;
const PAL_VARIANTS = [{ K: 2, res: 1 }, { K: 2, res: 2 }, { K: 4, res: 1 }, { K: 4, res: 2 }];
const GREY = [128, 128, 128];

function to565(c) {
  const cl = v => Math.max(0, Math.min(255, v));
  return (Math.round(cl(c[0]) / 255 * 31) << 11) | (Math.round(cl(c[1]) / 255 * 63) << 5) | Math.round(cl(c[2]) / 255 * 31);
}
function from565(v) { return [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31]; }
const yccLin = (r, g, b) => [0.299 * r + 0.587 * g + 0.114 * b, -0.168736 * r - 0.331264 * g + 0.5 * b, 0.5 * r - 0.418688 * g - 0.081312 * b];

// ---------------------------------------------------------------------------------------------------
// Static geometry / wavelet setup
function geo(cfg) {
  const T = cfg.T, nT = SIZE / T, nTiles = nT * nT;
  return { T, nT, nTiles, tb: Math.round(Math.log2(nTiles)) };
}

const wcache = new Map();
function wavSetup(cfg) {
  const key = `${cfg.steps.join(',')}/${cfg.chromaW}/${cfg.chromaDrop}/${cfg.dz}/${cfg.T}`;
  if (wcache.has(key)) return wcache.get(key);
  const layout = WL.makeLayout(cfg);
  const tab = PC.train(layout, trainingImages().map(img =>
    WL.quantizePlanes(I.rgbToYcc(I.resize(img, SIZE, SIZE)).map(p => p.data.map(v => v - 128)), layout, cfg)));
  const T = cfg.T, nT = SIZE / T;
  const posTile = new Int32Array(layout.total);
  const normSq = new Float64Array(layout.groups.length);
  layout.groups.forEach((g, gi) => {
    normSq[gi] = W.norms[g.si] ** 2;
    const sc = 1 << g.sb.level;
    for (let y = 0; y < g.sb.h; y++)
      for (let x = 0; x < g.sb.w; x++) {
        const px = Math.min(SIZE - 1, (x + 0.5) * sc), py = Math.min(SIZE - 1, (y + 0.5) * sc);
        posTile[g.start + y * g.sb.w + x] = Math.floor(py / T) * nT + Math.floor(px / T);
      }
  });
  // per Mallat coefficient position (all subbands, incl. chroma bands never sent): tile and norm^2
  const coefTile = new Int32Array(SIZE * SIZE), coefNormSq = new Float64Array(SIZE * SIZE);
  W.subbands().forEach((sb, si) => {
    const sc = 1 << sb.level;
    for (let y = 0; y < sb.h; y++)
      for (let x = 0; x < sb.w; x++) {
        const i = (sb.y + y) * SIZE + sb.x + x;
        coefTile[i] = Math.floor(Math.min(SIZE - 1, (y + 0.5) * sc) / T) * nT + Math.floor(Math.min(SIZE - 1, (x + 0.5) * sc) / T);
        coefNormSq[i] = W.norms[si] ** 2;
      }
  });
  const s = { layout, tab, posTile, normSq, coefTile, coefNormSq };
  wcache.set(key, s);
  return s;
}

// ---------------------------------------------------------------------------------------------------
// Decoder-side tile state (shared by encoder simulation)
function newTileState(G) {
  return {
    flat: new Array(G.nTiles).fill(null),
    meta: new Array(G.nTiles).fill(null), // {K, res}
    pal: Array.from({ length: G.nTiles }, () => [null, null, null, null]),
    idx: Array.from({ length: G.nTiles }, () => null),
  };
}

// returns the pixel position after the last completely read run (npix => segment complete)
function readRuns(rd, arr, pos, npix, K) {
  const kb = K === 4 ? 2 : 1;
  try {
    const k = rd.read(2);
    let sym = rd.read(kb), first = true;
    while (pos < npix) {
      if (!first) {
        if (K === 2) sym ^= 1;
        else { const s = rd.read(1) ? 1 + rd.read(1) : 0; sym = (sym + 1 + s) % 4; }
      }
      let r = rd.readEG(k) + 1;
      if (pos + r > npix) r = npix - pos;
      arr.fill(sym, pos, pos + r);
      pos += r; first = false;
    }
  } catch (e) { if (!(e instanceof RangeError)) throw e; return -1; }
  return pos;
}

function applyTilePacket(st, G, bits) {
  const rd = new BitReader(bits);
  try {
    rd.read(1); // leading 1
    if (rd.read(1)) { // FLAT
      const count = rd.read(G.tb) + 1;
      for (let i = 0; i < count; i++) {
        const t = rd.read(G.tb), c = rd.read(16);
        st.flat[t] = from565(c);
      }
      return;
    }
    // PAL segments; a segment whose index runs complete the tile may be followed by '1' + another segment
    for (;;) {
      const t = rd.read(G.tb), K = rd.read(1) ? 4 : 2, res = rd.read(1) ? 2 : 1, kind = rd.read(1);
      st.meta[t] = { K, res };
      if (!st.idx[t]) st.idx[t] = new Int8Array(G.T * G.T).fill(-1);
      const npix = (G.T / res) ** 2;
      let end;
      if (kind) {
        let e = rd.read(2);
        while (e < K) {
          if (rd.remaining < 16) return;
          st.pal[t][e] = from565(rd.read(16));
          e++;
        }
        end = readRuns(rd, st.idx[t], 0, npix, K);
      } else {
        const start = rd.read(Math.round(Math.log2(npix)));
        end = readRuns(rd, st.idx[t], start, npix, K);
      }
      if (end !== npix || !rd.read(1)) return;
    }
  } catch (e) { if (!(e instanceof RangeError)) throw e; }
}

function tileMode(st, t) { return st.meta[t] ? M_PAL : st.flat[t] ? M_FLAT : M_WAV; }

// writes the base OFFSET (RGB, added to the wavelet reconstruction which carries the +128) of tile t
// into img (Float64Array 256^2*3). mf (mean-free): the offset is colour - tile mean of the base, so the
// tile mean stays in the wavelet stream; otherwise colour - 128 (absolute base).
function renderTileBase(st, G, t, img, mf) {
  const T = G.T, tx = (t % G.nT) * T, ty = Math.floor(t / G.nT) * T;
  const mode = tileMode(st, t);
  if (mode !== M_PAL) {
    const c = mode === M_FLAT && !mf ? st.flat[t].map(v => v - 128) : [0, 0, 0];
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const o = ((ty + y) * SIZE + tx + x) * 3;
      img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2];
    }
    return;
  }
  const { K, res } = st.meta[t], pal = st.pal[t], idx = st.idx[t], w = T / res;
  if (!pal[0]) { // no colour known: no base
    for (let y = 0; y < T; y++) { const o = ((ty + y) * SIZE + tx) * 3; img.fill(0, o, o + T * 3); }
    return;
  }
  const cols = [0, 1, 2, 3].map(e => pal[e] || pal[0]);
  const mean = [0, 0, 0];
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    let i = idx[Math.floor(y / res) * w + Math.floor(x / res)];
    if (i < 0 || i >= K) i = 0;
    const c = cols[i], o = ((ty + y) * SIZE + tx + x) * 3;
    img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2];
    mean[0] += c[0]; mean[1] += c[1]; mean[2] += c[2];
  }
  const m = mf ? mean.map(v => v / (T * T)) : GREY;
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const o = ((ty + y) * SIZE + tx + x) * 3;
    img[o] -= m[0]; img[o + 1] -= m[1]; img[o + 2] -= m[2];
  }
}

// ---------------------------------------------------------------------------------------------------
// Encoder helpers
function planRuns(idx, pos, npix, K, avail, k) {
  const kb = K === 4 ? 2 : 1;
  let used = 2 + kb;
  const ops = [];
  if (used > avail || pos >= npix) return { end: pos, ops, used: 0 };
  let p = pos, sym = idx[p], prev = -1;
  while (p < npix) {
    let r = 1;
    while (p + r < npix && idx[p + r] === sym) r++;
    const s = prev < 0 ? -1 : (sym - prev - 1 + 4) % 4;
    const sb = prev < 0 || K === 2 ? 0 : s === 0 ? 1 : 2;
    let cost = sb + BitWriter.egLength(r - 1, k);
    if (used + cost > avail) {
      let rr = r - 1;
      while (rr >= 1 && used + sb + BitWriter.egLength(rr - 1, k) > avail) rr = Math.floor(rr / 2);
      // largest fitting length: egLength is monotone, refine upward
      if (rr >= 1) {
        while (rr + 1 < r && used + sb + BitWriter.egLength(rr, k) <= avail) rr++;
        ops.push({ s, r: rr }); used += sb + BitWriter.egLength(rr - 1, k); p += rr;
      }
      break;
    }
    ops.push({ s, r }); used += cost; p += r;
    prev = sym;
    if (p < npix) sym = idx[p];
  }
  if (!ops.length) return { end: pos, ops, used: 0 };
  return { end: p, ops, used, first: idx[pos] };
}

function writeRuns(w, idx, pos, npix, K, avail) {
  let best = null, bk = 0;
  for (let k = 0; k < 4; k++) {
    const pl = planRuns(idx, pos, npix, K, avail, k);
    if (!best || pl.end > best.end || (pl.end === best.end && pl.used < best.used)) { best = pl; bk = k; }
  }
  if (best.end === pos) return pos;
  w.write(bk, 2);
  w.write(best.first, K === 4 ? 2 : 1);
  best.ops.forEach((op, i) => {
    if (i > 0 && K === 4) { if (op.s === 0) w.write(0, 1); else w.write(2 + (op.s - 1), 2); }
    w.writeEG(op.r - 1, bk);
  });
  return best.end;
}

// Appends tile t's PAL segments to the packet stream S = {cur: BitWriter|null, cont: bool, packets: [{bits, tiles}]}.
// S.cont: S.cur ends with a completed tile, so a new segment may follow after a '1' bit. Returns false if
// the payload is too small for this variant.
function emitPalTile(S, G, t, v, pal565, idx, P) {
  const K = v.K, res = v.res, npix = (G.T / res) ** 2, pb = Math.round(Math.log2(npix));
  const close = () => { if (S.cur) S.packets.push({ bits: S.cur.bits, tiles: S.tiles }); S.cur = null; S.cont = false; };
  const open = kind => {
    const need = 1 + G.tb + 3 + 2 + 16;
    if (S.cur && S.cont && kind === 1 && P - S.cur.length >= need) { S.cur.write(1, 1); S.tiles.push(t); }
    else { close(); S.cur = new BitWriter(); S.cur.write(2, 2); S.tiles = [t]; }
    S.cont = false;
    const w = S.cur;
    w.write(t, G.tb); w.write(K === 4 ? 1 : 0, 1); w.write(res === 2 ? 1 : 0, 1); w.write(kind, 1);
    return w;
  };
  let e = 0, pos = 0;
  while (e < K) {
    const w = open(1);
    w.write(e, 2);
    const e1 = e;
    while (e < K && w.length + 16 <= P) { w.write(pal565[e], 16); e++; }
    if (e === e1) { close(); return false; }
    if (e === K) pos = writeRuns(w, idx, 0, npix, K, P - w.length);
    if (e < K || pos < npix) close();
  }
  while (pos < npix) {
    const w = open(0);
    w.write(pos, pb);
    const np = writeRuns(w, idx, pos, npix, K, P - w.length);
    if (np === pos) { close(); return false; }
    pos = np;
    if (pos < npix) close();
  }
  S.cont = P - S.cur.length > 0;
  return true;
}
function palPackets(G, t, v, pal565, idx, P) {
  const S = { cur: null, cont: false, packets: [], tiles: [] };
  if (!emitPalTile(S, G, t, v, pal565, idx, P)) return null;
  S.packets.push({ bits: S.cur.bits, tiles: S.tiles });
  return S.packets.map(p => p.bits);
}

function flatPackets(G, items, P) { // items: [{t, c565}]
  const per = Math.max(1, Math.min(1 << G.tb, Math.floor((P - 2 - G.tb) / (G.tb + 16))));
  const out = [];
  for (let i = 0; i < items.length; i += per) {
    const chunk = items.slice(i, i + per), w = new BitWriter();
    w.write(3, 2); w.write(chunk.length - 1, G.tb);
    for (const it of chunk) { w.write(it.t, G.tb); w.write(it.c565, 16); }
    out.push({ bits: w.bits, items: chunk });
  }
  return out;
}

function kmeans(pix, n, K) {
  // deterministic init: pixel nearest the mean, then repeatedly the pixel farthest from all centres
  const d2 = (i, c) => (pix[i * 3] - c[0]) ** 2 + (pix[i * 3 + 1] - c[1]) ** 2 + (pix[i * 3 + 2] - c[2]) ** 2;
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += pix[i * 3 + c] / n;
  let bi = 0;
  for (let i = 1; i < n; i++) if (d2(i, mean) < d2(bi, mean)) bi = i;
  const cent = [[pix[bi * 3], pix[bi * 3 + 1], pix[bi * 3 + 2]]];
  const dist = new Float64Array(n).fill(Infinity);
  while (cent.length < K) {
    const c = cent[cent.length - 1];
    bi = 0;
    for (let i = 0; i < n; i++) { const d = d2(i, c); if (d < dist[i]) dist[i] = d; if (dist[i] > dist[bi]) bi = i; }
    cent.push([pix[bi * 3], pix[bi * 3 + 1], pix[bi * 3 + 2]]);
  }
  for (let it = 0; it < 10; it++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < K; j++) {
        const d = (pix[i * 3] - cent[j][0]) ** 2 + (pix[i * 3 + 1] - cent[j][1]) ** 2 + (pix[i * 3 + 2] - cent[j][2]) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      const s = sum[best]; s[0] += pix[i * 3]; s[1] += pix[i * 3 + 1]; s[2] += pix[i * 3 + 2]; s[3]++;
    }
    for (let j = 0; j < K; j++) if (sum[j][3]) cent[j] = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
  }
  return cent;
}

// Palette candidate for one tile: returns {pal565, idx (Int8Array npix)}
function palCandidate(ref, G, t, v) {
  const T = G.T, tx = (t % G.nT) * T, ty = Math.floor(t / G.nT) * T, res = v.res, w = T / res, npix = w * w;
  const pix = new Float64Array(T * T * 3);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) for (let c = 0; c < 3; c++)
    pix[(y * T + x) * 3 + c] = ref.data[((ty + y) * SIZE + tx + x) * 3 + c];
  const cent = kmeans(pix, T * T, v.K);
  let colors = cent.map(c => from565(to565(c)));
  // block SSE assignment
  const assign = cols => {
    const idx = new Int8Array(npix), cnt = new Array(v.K).fill(0);
    for (let by = 0; by < w; by++) for (let bx = 0; bx < w; bx++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < v.K; j++) {
        let d = 0;
        for (let yy = 0; yy < res; yy++) for (let xx = 0; xx < res; xx++) {
          const o = ((by * res + yy) * T + bx * res + xx) * 3;
          d += (pix[o] - cols[j][0]) ** 2 + (pix[o + 1] - cols[j][1]) ** 2 + (pix[o + 2] - cols[j][2]) ** 2;
        }
        if (d < bd) { bd = d; best = j; }
      }
      idx[by * w + bx] = best; cnt[best]++;
    }
    return { idx, cnt };
  };
  let { idx, cnt } = assign(colors);
  // refit centroids on assigned pixels, requantize
  const sum = colors.map(() => [0, 0, 0, 0]);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const j = idx[Math.floor(y / res) * w + Math.floor(x / res)], o = (y * T + x) * 3, s = sum[j];
    s[0] += pix[o]; s[1] += pix[o + 1]; s[2] += pix[o + 2]; s[3]++;
  }
  colors = colors.map((c, j) => sum[j][3] ? from565(to565([sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]])) : c);
  ({ idx, cnt } = assign(colors));
  // order by frequency (index 0 = most frequent)
  const order = colors.map((_, j) => j).sort((a, b) => cnt[b] - cnt[a] || a - b);
  const remap = new Int8Array(v.K);
  order.forEach((j, r) => { remap[j] = r; });
  for (let i = 0; i < npix; i++) idx[i] = remap[idx[i]];
  return { pal565: order.map(j => to565(colors[j])), idx };
}

// ---------------------------------------------------------------------------------------------------
function buildConfigs(B) {
  const steps = B >= 256 ? [48, 12] : B >= 128 ? [48, 16, 5] : B >= 64 ? [96, 24] : [192, 48];
  const idxMax = B >= 128 ? 10 : 8;
  const base = { steps, chromaW: 2, chromaDrop: 1, dz: 0.2, idxMax, adapt: false, tgt: 20, refine: true, modes: 'p', mf: true };
  const L = `L${steps.join('-')}`;
  const mk = (o, suffix) => ({ ...base, ...o, label: `T${o.T}-${L}${suffix || ''}` }); // mf:false / modes:'fp' = absolute base variant (worse under loss, see header)
  return [
    mk({ T: 32, tgt: 5 }, '-t5'),
    mk({ T: 32, tgt: 10 }, '-t10'),
    mk({ T: 32, tgt: 20 }, '-t20'),
    mk({ T: 32, tgt: 40 }, '-t40'),
    mk({ T: 64, tgt: 10 }, '-t10'),
    mk({ T: 16, tgt: 10 }, '-t10'),
  ];
}

module.exports = {
  name: 'tile',
  _internal: { wavSetup, palCandidate, palPackets, newTileState, applyTilePacket },
  configs: buildConfigs,

  encode(ref0, cfg, P) {
    const G = geo(cfg);
    const { layout, tab, posTile, normSq, coefTile, coefNormSq } = wavSetup(cfg);
    const ref = I.resize(ref0, SIZE, SIZE);
    const refY = I.rgbToYcc(ref).map(p => p.data);
    const NPIX = SIZE * SIZE;
    const addr = PC.addressing(layout, cfg.idxMax);
    const hdr = 1 + addr.gBits + addr.idx.reduce((a, b) => a + b.bits, 0) / addr.idx.length;
    const ovh = P / Math.max(1, P - hdr);
    const Rt = cfg.tgt / 0.14 * P;
    // what the base has to predict: ref - 128 (absolute base) or ref - tile mean (mean-free base)
    const tileOf = i => Math.floor(Math.floor(i / SIZE) / G.T) * G.nT + Math.floor((i % SIZE) / G.T);
    const refB = [0, 1, 2].map(() => new Float64Array(NPIX));
    const Dg = new Float64Array(G.nTiles);
    {
      const tm = [0, 1, 2].map(() => new Float64Array(G.nTiles));
      for (let i = 0; i < NPIX; i++) for (let c = 0; c < 3; c++) tm[c][tileOf(i)] += refY[c][i] / (G.T * G.T);
      for (let i = 0; i < NPIX; i++) for (let c = 0; c < 3; c++) {
        const v = refY[c][i] - (cfg.mf ? tm[c][tileOf(i)] : 128);
        refB[c][i] = v; Dg[tileOf(i)] += CH_W[c] * v * v;
      }
    }
    const tileDist = (img, t) => {
      const T = G.T, tx = (t % G.nT) * T, ty = Math.floor(t / G.nT) * T;
      let d = 0;
      for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
        const i = (ty + y) * SIZE + tx + x, b = yccLin(img[i * 3], img[i * 3 + 1], img[i * 3 + 2]);
        for (let c = 0; c < 3; c++) d += CH_W[c] * (refB[c][i] - b[c]) ** 2;
      }
      return d;
    };

    // ---- candidates per tile: [{mode, v, bits, packets, st-rendered base (tile-local via full img)}]
    const cands = []; // cands[ci] = {mode, v, name}
    cands.push({ mode: M_WAV, name: 'wav' });
    if (cfg.modes.includes('f') && !cfg.mf) cands.push({ mode: M_FLAT, name: 'flat' });
    if (cfg.modes.includes('p')) for (const v of PAL_VARIANTS.filter(v => !cfg.modes.includes('p2') || v.K === 2)) cands.push({ mode: M_PAL, v, name: `pal${v.K}r${v.res}` });
    let nc = cands.length;
    // per candidate: base image (all tiles in that mode), per tile bits, per tile packets (PAL), flat colour
    const tileData = cands.map(() => new Array(G.nTiles));
    const baseImgs = cands.map(() => new Float64Array(NPIX * 3));
    cands.forEach((cd, ci) => {
      for (let t = 0; t < G.nTiles; t++) {
        const st = newTileState(G);
        let d;
        if (cd.mode === M_WAV) d = { bits: 0 };
        else if (cd.mode === M_FLAT) {
          const T = G.T, tx = (t % G.nT) * T, ty = Math.floor(t / G.nT) * T, m = [0, 0, 0];
          for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) for (let c = 0; c < 3; c++) m[c] += ref.data[((ty + y) * SIZE + tx + x) * 3 + c] / (T * T);
          const c565 = to565(m);
          st.flat[t] = from565(c565);
          d = { bits: G.tb + 16 + (2 + G.tb) / Math.max(1, Math.floor((P - 2 - G.tb) / (G.tb + 16))), c565 };
        } else {
          const pc = palCandidate(ref, G, t, cd.v);
          const packets = palPackets(G, t, cd.v, pc.pal565, pc.idx, P);
          if (!packets) { cd.unavailable = true; break; }
          for (const p of packets) applyTilePacket(st, G, p);
          d = { bits: packets.reduce((a, p) => a + p.length, 0), pal565: pc.pal565, idx: pc.idx };
        }
        renderTileBase(st, G, t, baseImgs[ci], cfg.mf);
        d.gain = Dg[t] - tileDist(baseImgs[ci], t);
        tileData[ci][t] = d;
      }
    });

    for (let ci = nc - 1; ci >= 0; ci--) if (cands[ci].unavailable) { cands.splice(ci, 1); tileData.splice(ci, 1); baseImgs.splice(ci, 1); }
    nc = cands.length;
    const composeBase = modes => {
      const img = new Float64Array(NPIX * 3);
      const T = G.T;
      for (let t = 0; t < G.nTiles; t++) {
        const src = baseImgs[modes[t]], tx = (t % G.nT) * T, ty = Math.floor(t / G.nT) * T;
        for (let y = 0; y < T; y++) {
          const o = ((ty + y) * SIZE + tx) * 3;
          for (let i = 0; i < T * 3; i++) img[o + i] = src[o + i];
        }
      }
      return img;
    };
    const residual = base => {
      const res = [0, 1, 2].map(() => new Float64Array(NPIX));
      const Dt = new Float64Array(G.nTiles);
      for (let i = 0; i < NPIX; i++) {
        const b = yccLin(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
        const t = tileOf(i);
        for (let c = 0; c < 3; c++) {
          const r = refY[c][i] - 128 - b[c];
          res[c][i] = r;
          Dt[t] += CH_W[c] * r * r;
        }
      }
      return { res, Dt };
    };
    // wavelet analysis: gains (pixel-domain), bits estimate
    const wavAnalyse = res => {
      const gains = new Float64Array(layout.total);
      const q = WL.quantizePlanes(res, layout, cfg, gains);
      const bits = new Float64Array(layout.total);
      let lastNZ = layout.denseEnd - 1;
      layout.groups.forEach((g, gi) => {
        const ns = normSq[gi];
        let prev = 0;
        for (let p = g.start; p < g.start + g.nb; p++) {
          gains[p] *= ns;
          if (p < layout.denseEnd) {
            bits[p] = BitWriter.segLength(q[p] - prev, tab.dc[gi]) * ovh; prev = q[p];
          } else if (q[p] !== 0) {
            bits[p] = (BitWriter.egLength(p - lastNZ - 1, tab.run[gi]) + BitWriter.segLength(q[p], tab.lvl[gi])) * ovh;
            lastNZ = p;
          }
        }
      });
      return { q, gains, bits };
    };
    const tileJ = (an, Dt, lam) => {
      const J = Float64Array.from(Dt);
      const { gains, bits } = an;
      for (let p = 0; p < layout.total; p++) {
        if (!bits[p]) continue;
        const c = gains[p] - lam * bits[p];
        if (c > 0) J[posTile[p]] -= c;
      }
      return J;
    };
    const lambdaFor = (an, modes) => {
      const ratio = [], bitsArr = [];
      for (let p = 0; p < layout.total; p++) if (an.bits[p] && an.gains[p] > 0) { ratio.push(an.gains[p] / an.bits[p]); bitsArr.push(an.bits[p]); }
      for (let t = 0; t < G.nTiles; t++) {
        const b = tileData[modes[t]][t].bits;
        if (b > 0) { ratio.push(Math.max(0, tileData[modes[t]][t].gain) / b); bitsArr.push(b); }
      }
      const ord = ratio.map((_, i) => i).sort((a, b) => ratio[b] - ratio[a]);
      let acc = 0;
      for (const i of ord) { acc += bitsArr[i]; if (acc >= Rt) return ratio[i]; }
      return ord.length ? ratio[ord[ord.length - 1]] * 0.5 : 1;
    };
    const evalModes = (modes, lam) => {
      const { res } = residual(composeBase(modes));
      // distortion without wavelet, measured in the (norm-weighted) coefficient domain like the gains, so
      // both terms of J share one scale (the 9/7 basis is not orthogonal: pixel SSE != coefficient SSE)
      const Dt = new Float64Array(G.nTiles);
      res.forEach((p, c) => {
        const cf = W.fwd2d(p);
        for (let i = 0; i < cf.length; i++) Dt[coefTile[i]] += CH_W[c] * cf[i] * cf[i] * coefNormSq[i];
      });
      const an = wavAnalyse(res);
      const J = tileJ(an, Dt, lam);
      let tot = 0;
      for (let t = 0; t < G.nTiles; t++) tot += J[t] + lam * tileData[modes[t]][t].bits;
      return { tot, J, an };
    };

    let modes = new Int32Array(G.nTiles); // candidate index per tile
    let lam = null, Jtab = null;
    if (nc > 1) {
      for (let round = 0; round < 2; round++) {
        if (lam === null || round > 0) {
          const e = evalModes(modes, 1);
          lam = lambdaFor(e.an, modes);
        }
        Jtab = cands.map((_, ci) => {
          const m = new Int32Array(G.nTiles).fill(ci);
          const e = evalModes(m, lam);
          return Array.from(e.J, (j, t) => j + lam * tileData[ci][t].bits);
        });
        modes = modes.map((_, t) => {
          let best = 0;
          for (let ci = 1; ci < nc; ci++) if (Jtab[ci][t] < Jtab[best][t]) best = ci;
          return best;
        });
      }
      let cur = evalModes(modes, lam).tot;
      const allWav = evalModes(new Int32Array(G.nTiles), lam).tot;
      if (allWav < cur) { modes = new Int32Array(G.nTiles); cur = allWav; }
      if (cfg.refine) {
        for (let t = 0; t < G.nTiles; t++) {
          const alts = cands.map((_, ci) => ci).filter(ci => ci !== modes[t]).sort((a, b) => Jtab[a][t] - Jtab[b][t]).slice(0, 2);
          for (const ci of alts) {
            const old = modes[t];
            modes[t] = ci;
            const tot = evalModes(modes, lam).tot;
            if (tot < cur) cur = tot; else modes[t] = old;
          }
        }
      }
    }

    // ---- final streams
    const { res } = residual(composeBase(modes));
    const gains = new Float64Array(layout.total);
    const q = WL.quantizePlanes(res, layout, cfg, gains);
    layout.groups.forEach((g, gi) => { for (let p = g.start; p < g.start + g.nb; p++) gains[p] *= normSq[gi]; });
    const { runs, spans } = PC.encodeStream(layout, tab, q, P - 1, cfg);
    const pre = new Float64Array(layout.total + 1);
    for (let i = 0; i < layout.total; i++) pre[i + 1] = pre[i] + gains[i];
    const items = []; // {bits, key, wav}
    runs.forEach((r, i) => items.push({ bits: [0].concat(r), key: pre[spans[i][1]] - pre[spans[i][0]], wav: true }));

    // flat tiles
    const flats = [];
    for (let t = 0; t < G.nTiles; t++) if (cands[modes[t]].mode === M_FLAT) flats.push({ t, c565: tileData[modes[t]][t].c565, g: tileData[modes[t]][t].gain });
    flats.sort((a, b) => b.g - a.g || a.t - b.t);
    for (const fp of flatPackets(G, flats, P)) items.push({ bits: fp.bits, key: fp.items.reduce((a, it) => a + it.g, 0) });

    // palette stream: tiles by gain per bit, segments of consecutive tiles share packets; keys = exact
    // prefix gains (simulated decoder) made non-increasing by pool-adjacent-violators
    {
      const palTiles = [];
      for (let t = 0; t < G.nTiles; t++) if (cands[modes[t]].mode === M_PAL) palTiles.push(t);
      palTiles.sort((a, b) => tileData[modes[b]][b].gain / tileData[modes[b]][b].bits - tileData[modes[a]][a].gain / tileData[modes[a]][a].bits || a - b);
      const S = { cur: null, cont: false, packets: [], tiles: [] };
      for (const t of palTiles) {
        const cd = cands[modes[t]], d = tileData[modes[t]][t];
        if (!emitPalTile(S, G, t, cd.v, d.pal565, d.idx, P)) throw new Error('tile: PAL emit failed');
      }
      if (S.cur) S.packets.push({ bits: S.cur.bits, tiles: S.tiles });
      const st = newTileState(G);
      const img = new Float64Array(NPIX * 3);
      const dCur = Float64Array.from(Dg);
      const g = S.packets.map(p => {
        applyTilePacket(st, G, p.bits);
        let gg = 0;
        for (const t of new Set(p.tiles)) {
          renderTileBase(st, G, t, img, cfg.mf);
          const d = tileDist(img, t);
          gg += dCur[t] - d; dCur[t] = d;
        }
        return gg;
      });
      const blocks = [];
      g.forEach(v => {
        blocks.push({ s: v, n: 1 });
        while (blocks.length > 1 && blocks[blocks.length - 1].s / blocks[blocks.length - 1].n > blocks[blocks.length - 2].s / blocks[blocks.length - 2].n) {
          const b = blocks.pop(); blocks[blocks.length - 1].s += b.s; blocks[blocks.length - 1].n += b.n;
        }
      });
      let j = 0;
      for (const b of blocks) for (let k = 0; k < b.n; k++, j++) items.push({ bits: S.packets[j].bits, key: b.s / b.n });
    }
    const order = items.map((_, i) => i).sort((a, b) => items[b].key - items[a].key || a - b);
    const units = order.map(i => items[i].bits);
    let baseCount = 0;
    while (baseCount < order.length && !items[order[baseCount]].wav) baseCount++;
    const counts = {};
    for (const m of modes) counts[cands[m].name] = (counts[cands[m].name] || 0) + 1;
    return { units, baseCount, modeCounts: counts, lambda: lam, modes: Array.from(modes, m => cands[m].name) };
  },

  decoder(cfg, P) {
    const G = geo(cfg);
    const { layout, tab } = wavSetup(cfg);
    const q = new Int32Array(layout.total);
    const st = newTileState(G);
    return {
      stateInfo: `wavl coef textures ${cfg.steps.length}x256^2x3 + tile table ${G.nT}x${G.nT} (mode,K,res,4 pal,flat) + index tex 256^2`,
      apply(bits) {
        if (!bits.length) return;
        if (bits[0] === 0) PC.apply(layout, tab, q, bits.slice(1), cfg);
        else applyTilePacket(st, G, bits);
      },
      render() {
        const base = new Float64Array(SIZE * SIZE * 3);
        for (let t = 0; t < G.nTiles; t++) renderTileBase(st, G, t, base, cfg.mf);
        const planes = WL.reconstructPlanes(q, layout);
        const out = I.create(SIZE, SIZE, 3);
        for (let i = 0; i < SIZE * SIZE; i++) {
          const b = yccLin(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
          const y = 128 + b[0] + planes[0][i], cb = b[1] + planes[1][i], cr = b[2] + planes[2][i];
          out.data[i * 3] = y + 1.402 * cr;
          out.data[i * 3 + 1] = y - 0.344136 * cb - 0.714136 * cr;
          out.data[i * 3 + 2] = y + 1.772 * cb;
        }
        return I.quantize8(out);
      },
    };
  },
};
