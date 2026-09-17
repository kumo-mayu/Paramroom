'use strict';
// Evaluate one (codec, cfg, B, crcBits, image) task over a grid of channel scenarios (transport v2).
//
// Packet on the wire (B bits): [epoch (2)] [crc (crcBits)] [codec payload (P = B - 2 - crcBits)].
// Torn snapshots mix bytes of two packets; with crcBits > 0 the receiver drops packets whose CRC fails.
const path = require('path');
const crypto = require('crypto');
const I = require('./image');
const M = require('./metrics');
const T = require('./transport');

const TIMES = [1, 2, 5, 10, 20, 40, 60];

const GRIDS = {
  // stage 1: config selection on training images, one nominal channel
  select: {
    channels: [{ name: 'bm14', sampler: 'bmfit', H: 0.14 }],
    join: [0], policy: [{ type: 'carousel' }], capSeconds: [60], times: TIMES, seeds: 4,
  },
  // stage 2: robustness comparison on test images
  full: {
    channels: [
      { name: 'nom117', sampler: 'nominal10', H: 7 / 60 },
      { name: 'bm12', sampler: 'bmfit', H: 0.12 },
      { name: 'bm14', sampler: 'bmfit', H: 0.14 },
      { name: 'bm20', sampler: 'bmfit', H: 0.2 },
      { name: 'bm14cull', sampler: 'bmfit', H: 0.14, burst: true },
      { name: 'bm14torn', sampler: 'bmfit', H: 0.14, torn: 0.05 },
    ],
    join: [0, 30], policy: [{ type: 'carousel' }, { type: 'prio', period: 4 }], capSeconds: [30, 90], times: TIMES, seeds: 6,
  },
  // late join at a random time (uniform 20..80 s after sending started) under three send policies
  latejoin: {
    channels: [{ name: 'bm14', sampler: 'bmfit', H: 0.14 }],
    join: ['rand'], policy: [{ type: 'carousel' }, { type: 'prio', period: 4 }, { type: 'tier' }], capSeconds: [30, 90], times: TIMES, seeds: 8,
  },
  // short-cycle re-send of the first units of the SAME efficient stream (alternative to a separate thumbnail)
  latejoin2: {
    channels: [{ name: 'bm14', sampler: 'bmfit', H: 0.14 }],
    join: [0, 'rand'],
    policy: [{ type: 'prio', period: 4, base: 8, label: 'prio4b8' }, { type: 'prio', period: 4, base: 16, label: 'prio4b16' }, { type: 'prio', period: 8, base: 8, label: 'prio8b8' }],
    capSeconds: [30, 90], times: TIMES, seeds: 8,
  },
  // ---- grids with the measured channel (sampler meas60) ----
  // torn: 0.007 = OSC bundle, 0.06 = individual OSC messages (measured)
  mselect: {
    channels: [{ name: 'm100b', sampler: 'meas60', H: 0.1, torn: 0.007 }],
    join: [0], policy: [{ type: 'carousel' }], capSeconds: [60], times: TIMES, seeds: 4,
  },
  mfull: {
    channels: [
      { name: 'm083b', sampler: 'meas60', H: 1 / 12, torn: 0.007 },
      { name: 'm100b', sampler: 'meas60', H: 0.1, torn: 0.007 },
      { name: 'm117b', sampler: 'meas60', H: 7 / 60, torn: 0.007 },
      { name: 'm100i', sampler: 'meas60', H: 0.1, torn: 0.06 },
    ],
    join: [0, 'rand'],
    policy: [{ type: 'carousel' }, { type: 'tier' }, { type: 'prio', period: 4, base: 8, label: 'prio4b8' }],
    capSeconds: [30, 90], times: TIMES, seeds: 6,
  },
  // literature candidates: square-root-rule schedules vs current policies (measured channel, OSC bundle)
  lit: {
    channels: [{ name: 'm100b', sampler: 'meas60', H: 0.1, torn: 0.007 }],
    join: [0, 'rand'],
    policy: [
      { type: 'carousel' }, { type: 'tier' }, { type: 'prio', period: 4, base: 8, label: 'prio4b8' },
      { type: 'sqrt', alpha: 0, label: 'sqrt' }, { type: 'sqrt', alpha: 0.3, label: 'sqrt30' }, { type: 'sqrt', alpha: 0.6, label: 'sqrt60' },
    ],
    capSeconds: [30, 90], times: TIMES, seeds: 6,
  },
  // CRC comparison for B=32 (CRC-8 does not fit most codecs)
  crc32: {
    channels: [{ name: 'bm14', sampler: 'bmfit', H: 0.14 }, { name: 'bm14torn', sampler: 'bmfit', H: 0.14, torn: 0.05 }],
    join: [0], policy: [{ type: 'carousel' }], capSeconds: [30, 90], times: TIMES, seeds: 6,
  },
};

function loadCodec(name) { return require(path.join(__dirname, '..', 'codecs', name)); }

function padBits(bits, P) {
  if (bits.length > P) throw new Error(`unit too long: ${bits.length} > ${P}`);
  return bits.length === P ? bits : bits.concat(new Array(P - bits.length).fill(0));
}

function hash(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

function evaluateTask({ codec: codecName, cfg, B, image, crcBits = 0, grid: gridName = 'full', imageDir = 'ref' }) {
  const grid = GRIDS[gridName];
  const codec = loadCodec(codecName);
  const ref = I.loadPNG(path.join(__dirname, '..', 'images', imageDir, image + '.png'));
  const P = B - T.EPOCH_BITS - crcBits;
  const t0 = Date.now();
  const enc = codec.encode(ref, cfg, P);
  const encMs = Date.now() - t0;
  const payloads = enc.units.map(u => padBits(u, P));
  // full wire packets (epoch = 0)
  const wire = payloads.map(p => {
    const head = [0, 0];
    if (!crcBits) return head.concat(p);
    const c = T.crc(head.concat(p), crcBits);
    const cb = [];
    for (let i = crcBits - 1; i >= 0; i--) cb.push((c >> i) & 1);
    return head.concat(cb, p);
  });
  const receive = bits => {
    // returns payload or null if CRC fails
    if (crcBits) {
      const head = bits.slice(0, T.EPOCH_BITS), cb = bits.slice(T.EPOCH_BITS, T.EPOCH_BITS + crcBits), p = bits.slice(T.EPOCH_BITS + crcBits);
      let c = 0;
      for (const b of cb) c = (c << 1) | b;
      if (T.crc(head.concat(p), crcBits) !== c) return null;
      return p;
    }
    return bits.slice(T.EPOCH_BITS);
  };
  const grey = I.create(256, 256, 3, 128);
  const cache = new Map();
  const rows = [];
  const tMax = Math.max(...grid.times);
  let tornSeen = 0, tornAccepted = 0;

  for (const capSeconds of grid.capSeconds) {
    for (const ch of grid.channels) {
      // dual-stream codecs: the cap applies to the detail stream only (thumbnail units always kept)
      const N = enc.schedule && enc.schedule.type === 'dual'
        ? Math.min(payloads.length, enc.baseCount + Math.max(1, Math.floor(capSeconds / ch.H)))
        : Math.min(payloads.length, Math.max(1, Math.floor(capSeconds / ch.H)));
      const baseCount = Math.min(Math.max(enc.baseCount || 0, Math.ceil(N * 0.1)), N);
      for (const policy of grid.policy) {
        // codecs may impose their own schedule (e.g. dual-stream); rows keep the grid policy label
        const schedule = enc.schedule ? T.makeSchedule(N, enc.schedule, enc.baseCount) : T.makeSchedule(N, policy, policy.base || baseCount, enc.gains ? enc.gains.slice(0, N) : null);
        for (const join of grid.join) {
          for (let seed = 1; seed <= grid.seeds; seed++) {
            const joinT = join === 'rand' ? 20 + 60 * T.mulberry32(seed * 104729 + 7)() : join;
            const arr = T.arrivals({ schedule, H: ch.H, channel: ch, join: joinT, tMax, seed: seed * 7919 + 13, packetBytes: B / 8 });
            const dec = codec.decoder(cfg, P);
            const clean = new Set();
            const seq = [];
            let dirty = false;
            let ai = 0;
            for (const t of grid.times) {
              while (ai < arr.length && arr[ai].time <= t + 1e-9) {
                const a = arr[ai++];
                if (!a.tearByte) {
                  dec.apply(payloads[a.unit]);
                  clean.add(a.unit);
                  seq.push(String(a.unit));
                } else {
                  tornSeen++;
                  const nb = a.tearByte * 8;
                  const mixed = wire[a.unit].slice(0, nb).concat(wire[a.prev].slice(nb));
                  const p = receive(mixed);
                  if (!p) continue;
                  const same = mixed.every((b, i) => b === wire[a.unit][i]);
                  if (same) { dec.apply(payloads[a.unit]); clean.add(a.unit); seq.push(String(a.unit)); continue; }
                  tornAccepted++;
                  dec.apply(p);
                  dirty = true;
                  seq.push(`t${a.unit}:${a.prev}:${a.tearByte}`);
                }
              }
              // Decoders are idempotent & order independent for clean packets: the received set is the state.
              // Once a corrupted packet was applied, the exact arrival sequence is the state.
              const key = dirty ? hash(seq.join(',')) : hash([...clean].sort((x, y) => x - y).join(','));
              let m = cache.get(key);
              if (!m) {
                m = M.all(ref, seq.length ? dec.render() : grey);
                cache.set(key, m);
              }
              rows.push({
                image, codec: codecName, cfg: cfg.label, B, crc: crcBits, cap: capSeconds, N, total: payloads.length,
                ch: ch.name, policy: policy.label || policy.type, join, seed, t, got: clean.size,
                psnr: +m.psnr.toFixed(3), ssim: +m.ssim.toFixed(4), msssim: +m.msssim.toFixed(4), ssimc: +m.ssimc.toFixed(4), msssimc: +m.msssimc.toFixed(4),
              });
            }
          }
        }
      }
    }
  }
  return { rows, encMs, totalUnits: payloads.length, baseCount: enc.baseCount, tornSeen, tornAccepted };
}

module.exports = { evaluateTask, GRIDS, TIMES, padBits, loadCodec };
