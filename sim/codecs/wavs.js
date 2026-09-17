'use strict';
// WAVS: same wavelet source coding as WAV, but "sequence-numbered chained packets" framing.
//
// Packet = [seq (U bits)] [payload P-U bits]. Packets are grouped into static segments of M packets.
// Each segment is one continuous bitstream (a packet-coder run: [group id][aligned index] symbols...),
// symbols may straddle packet boundaries, and adaptive Golomb state persists across the segment.
// The decoder stores raw packets by seq (2^U x P bits of texels) and decodes each segment's longest
// contiguous received prefix: a gap stalls the rest of that segment until the carousel repeats it.
// Header overhead: U bits per packet + address once per segment (WAV: address in every packet).
// Shader side: raw packet store + a sequential decoder pass (per segment) scattering coefficients.
const { BitWriter, BitReader } = require('../lib/bits');
const PC = require('./packet-coder');
const W = require('./wav')._internal;

module.exports = {
  name: 'wavs',
  configs(B) {
    const steps = B >= 128 ? [6, 12, 24] : B >= 64 ? [12, 24, 48] : [24, 48, 96];
    const Us = B >= 64 ? [10] : [8, 10];
    const out = [];
    for (const U of Us) for (const rd of [false, true]) for (const M of [4, 16]) for (const step of steps)
      out.push({ label: `q${step}-m${M}${rd ? '-rd' : ''}${Us.length > 1 ? '-u' + U : ''}`, step, chromaW: 2, chromaDrop: 1, dz: 0.2, idxMax: 10, adapt: false, M, U, rd });
    return out;
  },
  encode(ref, cfg, P) {
    const { layout, tab } = W.setup(cfg);
    const gains = new Float64Array(layout.total);
    const q = W.quantize(ref, layout, cfg, gains);
    const C = P - cfg.U;
    const { runs, baseRuns, spans } = PC.encodeStream(layout, tab, q, cfg.M * C, cfg);
    const units = [];
    // seq numbers follow stream order; with rd, whole segments are sent in descending gain order
    for (const bits of runs) {
      for (let k = 0; k < cfg.M && units.length < (1 << cfg.U); k++) {
        const w = new BitWriter();
        w.write(units.length, cfg.U);
        w.bits.push(...bits.slice(k * C, (k + 1) * C));
        units.push(w.bits);
      }
    }
    while (units.length && units[units.length - 1].length === cfg.U) units.pop();
    if (!cfg.rd) return { units, baseCount: Math.min(units.length, baseRuns * cfg.M) };
    const order = W.rdOrder(spans, gains);
    const sent = [];
    for (const s of order) for (let k = 0; k < cfg.M; k++) if (units[s * cfg.M + k]) sent.push(units[s * cfg.M + k]);
    return { units: sent, baseCount: 0 };
  },
  decoder(cfg, P) {
    const { layout, tab } = W.setup(cfg);
    const store = new Map();
    const C = P - cfg.U;
    return {
      stateInfo: `raw packet store (${1 << cfg.U} x ${P} bits) + coef texture ${layout.total}`,
      apply(bits) {
        const seq = new BitReader(bits).read(cfg.U);
        store.set(seq, bits.slice(cfg.U, cfg.U + C));
      },
      render() {
        const q = new Int32Array(layout.total);
        const segs = new Set([...store.keys()].map(s => Math.floor(s / cfg.M)));
        for (const s of segs) {
          const cat = [];
          for (let k = 0; k < cfg.M; k++) {
            const pk = store.get(s * cfg.M + k);
            if (!pk) break;
            cat.push(...pk);
          }
          PC.decodeRun(layout, tab, q, cat, cfg);
        }
        return W.reconstruct(q, layout, cfg);
      },
    };
  },
};
