'use strict';
// Generic variable-length coder for a linear stream of quantized integers, framed as self-contained
// "runs" of bits: [group id (gBits)] [aligned index within group (idxBits_g)] symbols...
//
// layout: { groups: [{start, nb}], total, posGroup: Int32Array, denseEnd }
//   Positions [0, denseEnd) are "dense" (DPCM + signed Exp-Golomb), the rest "sparse" (zero-run EG + level SEG).
//   The start index is rounded down to a multiple of 2^align_g so that idxBits_g <= idxMax;
//   the first symbol's run covers the alignment gap (earlier nonzeros in the gap are not rewritten).
// Decoding writes only nonzero/dense values at explicit positions => idempotent and order-independent.
//
// opts: { idxMax (default 10), adapt (bool) }
//   adapt: Exp-Golomb order per (group, symbol kind) adapts LOCO-I style from running magnitude sums
//   (state reset at the start of every run of bits, initialised from the static trained table).
const { BitWriter, BitReader } = require('../lib/bits');

const K = 7;

function addressing(layout, idxMax = 10) {
  const gBits = Math.max(1, Math.ceil(Math.log2(layout.groups.length)));
  const idx = layout.groups.map(g => {
    const full = Math.max(1, Math.ceil(Math.log2(g.nb)));
    const align = Math.max(0, full - idxMax);
    return { bits: full - align, align };
  });
  return { gBits, idx };
}

function train(layout, streams) {
  const n = layout.groups.length;
  const dc = Array.from({ length: n }, () => new Float64Array(K));
  const run = Array.from({ length: n }, () => new Float64Array(K));
  const lvl = Array.from({ length: n }, () => new Float64Array(K));
  for (const q of streams) {
    layout.groups.forEach((g, gi) => {
      if (g.start < layout.denseEnd) {
        for (let b = 0; b < g.nb; b++) {
          const d = q[g.start + b] - (b ? q[g.start + b - 1] : 0);
          for (let k = 0; k < K; k++) dc[gi][k] += BitWriter.segLength(d, k);
        }
      } else {
        let r = 0;
        for (let b = 0; b < g.nb; b++) {
          const v = q[g.start + b];
          if (v === 0) { r++; continue; }
          for (let k = 0; k < K; k++) { run[gi][k] += BitWriter.egLength(r, k); lvl[gi][k] += BitWriter.segLength(v, k); }
          r = 0;
        }
      }
    });
  }
  const argmin = a => a.indexOf(Math.min(...a));
  return { dc: dc.map(argmin), run: run.map(argmin), lvl: lvl.map(argmin) };
}

// Adaptive Exp-Golomb order context (per symbol kind x group).
class Ctx {
  constructor(tab, adapt) {
    this.tab = tab; this.adapt = adapt;
    if (adapt) { this.A = new Map(); this.N = new Map(); }
  }
  k(kind, gi) {
    const k0 = this.tab[kind][gi];
    if (!this.adapt) return k0;
    const key = kind + gi;
    if (!this.N.has(key)) { this.N.set(key, 2); this.A.set(key, 2 * (1 << k0)); }
    const N = this.N.get(key), A = this.A.get(key);
    let k = 0;
    while ((N << (k + 1)) < A && k < K - 1) k++;
    return k;
  }
  update(kind, gi, mag) {
    if (!this.adapt) return;
    const key = kind + gi;
    let N = this.N.get(key) + 1, A = this.A.get(key) + mag;
    if (N >= 32) { N >>= 1; A >>= 1; }
    this.N.set(key, N); this.A.set(key, A);
  }
}
const segMag = v => (v > 0 ? 2 * v - 1 : -2 * v);

function nextNonzero(q, total) {
  const nextNZ = new Int32Array(total + 1);
  nextNZ[total] = total;
  for (let i = total - 1; i >= 0; i--) nextNZ[i] = q[i] !== 0 ? i : nextNZ[i + 1];
  return nextNZ;
}

// Encode one run of at most `cap` bits starting at `pos` (a dense position or a nonzero).
function encodeRun(layout, tab, q, nextNZ, pos, cap, opts) {
  const addr = addressing(layout, opts.idxMax);
  const total = layout.total;
  const gi = layout.posGroup[pos], g = layout.groups[gi], a = addr.idx[gi];
  const w = new BitWriter();
  w.write(gi, addr.gBits);
  w.write((pos - g.start) >> a.align, a.bits);
  const headerLen = w.length;
  const ctx = new Ctx(tab, opts.adapt);
  let cur = g.start + (((pos - g.start) >> a.align) << a.align);
  let prev = 0, prevGi = -1, first = true;
  while (cur < total) {
    const cg = layout.posGroup[cur];
    if (cur < layout.denseEnd) {
      const d = q[cur] - (prevGi === cg ? prev : 0);
      const k = ctx.k('dc', cg);
      if (w.length + BitWriter.segLength(d, k) > cap) break;
      w.writeSEG(d, k); ctx.update('dc', cg, segMag(d));
      prev = q[cur]; prevGi = cg; cur++; first = false;
    } else {
      // first symbol targets pos itself (earlier nonzeros in the alignment gap belong to the previous run)
      const nz = first ? pos : nextNZ[cur];
      first = false;
      if (nz >= total) { cur = total; break; }
      const gl = layout.posGroup[nz];
      const kr = ctx.k('run', cg), kl = ctx.k('lvl', gl);
      if (w.length + BitWriter.egLength(nz - cur, kr) + BitWriter.segLength(q[nz], kl) > cap) break;
      w.writeEG(nz - cur, kr); ctx.update('run', cg, nz - cur);
      w.writeSEG(q[nz], kl); ctx.update('lvl', gl, segMag(q[nz]));
      cur = nz + 1;
    }
  }
  return { bits: w.bits, end: cur, empty: w.length === headerLen };
}

// Split the whole stream into runs of at most `cap` bits. Returns { runs, baseRuns }.
function encodeStream(layout, tab, q, cap, opts = {}) {
  const nextNZ = nextNonzero(q, layout.total);
  const runs = [], spans = [];
  let pos = 0, baseRuns = 0;
  while (true) {
    if (pos >= layout.denseEnd) pos = nextNZ[pos];
    if (pos >= layout.total) break;
    const r = encodeRun(layout, tab, q, nextNZ, pos, cap, opts);
    if (r.empty) {
      // a single symbol (long alignment run or huge level) does not fit an empty run: drop it (lossy)
      if (cap < 24) throw new Error('payload too small for one symbol');
      pos = pos + 1;
      continue;
    }
    runs.push(r.bits);
    spans.push([pos, r.end]);
    pos = r.end;
    if (pos <= layout.denseEnd) baseRuns = runs.length;
  }
  return { runs, baseRuns, spans };
}

function decodeRun(layout, tab, q, bits, opts = {}) {
  const addr = addressing(layout, opts.idxMax);
  const r = new BitReader(bits);
  let pos;
  try {
    const gi0 = r.read(addr.gBits);
    if (gi0 >= layout.groups.length) return;
    const g0 = layout.groups[gi0], a0 = addr.idx[gi0];
    pos = g0.start + (r.read(a0.bits) << a0.align);
  } catch (e) { if (e instanceof RangeError) return; throw e; }
  const ctx = new Ctx(tab, opts.adapt);
  let prev = 0, prevGi = -1;
  // The gap before the first symbol of a run that starts in the sparse region is only alignment padding
  // (it may overlap the previous run), so it must not be zero-filled. All later gaps are true zeros of this
  // run and are written, so a corrupted value inside this run's span is repaired when the run is re-received.
  let gapIsPadding = pos >= layout.denseEnd;
  try {
    while (pos < layout.total) {
      const gi = layout.posGroup[pos];
      if (pos < layout.denseEnd) {
        const d = r.readSEG(ctx.k('dc', gi));
        ctx.update('dc', gi, segMag(d));
        const v = (prevGi === gi ? prev : 0) + d;
        q[pos] = v; prev = v; prevGi = gi; pos++; gapIsPadding = false;
      } else {
        const run = r.readEG(ctx.k('run', gi));
        ctx.update('run', gi, run);
        const nz = pos + run;
        if (nz >= layout.total) break;
        const gl = layout.posGroup[nz];
        const lv = r.readSEG(ctx.k('lvl', gl));
        ctx.update('lvl', gl, segMag(lv));
        if (!gapIsPadding) for (let i = pos; i < nz; i++) q[i] = 0;
        gapIsPadding = false;
        q[nz] = lv;
        pos = nz + 1;
      }
    }
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
}

// One run per packet.
function encode(layout, tab, q, P, opts = {}) {
  const { runs, baseRuns } = encodeStream(layout, tab, q, P, opts);
  return { units: runs, baseCount: baseRuns };
}
function apply(layout, tab, q, bits, opts = {}) { decodeRun(layout, tab, q, bits, opts); }

module.exports = { train, encode, apply, encodeStream, decodeRun, addressing };
