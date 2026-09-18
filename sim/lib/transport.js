'use strict';
// Channel / transport model (v2).
//
// All of this is a HYPOTHESIS to be replaced by in-game measurements (docs/research/01 §9).
//  * Sender: slot k holds packet schedule(k) during [k*H, (k+1)*H) (OSC app timing).
//  * Network: the sender's client takes snapshots of all parameters at "sample" times (renewal process).
//    A remote receives each snapshot (last-value-wins). Loss is therefore a CONSEQUENCE of H vs the sample
//    interval distribution, not an independent parameter:
//      - 'nominal10': ticks every 100 ms +- N(0, 4 ms), snapshot taken at the next sender frame (60 fps).
//      - 'bmfit':     interval ~ U[100, 180] ms. Chosen to roughly reproduce VRCBitmapLed's table
//                     (100 ms: heavy loss, 120 ms: ~1/5, 130 ms: ~1/7, 140 ms: rare, 200 ms: none).
//  * Bursts ('cull'): the viewer does not process updates during outages (looking away / animator culled /
//    distance hidden): alternating renewal, ON ~ Exp(mean 30 s), OFF ~ Exp(mean 4 s).
//  * Torn snapshots: when a snapshot catches a packet change, with probability `torn` it contains the first j
//    bytes (8-bit parameters) of the new packet and the rest of the previous packet (non-atomic OSC writes).
//  * Latency: constant 150 ms from snapshot to remote apply.
//  * Late join: the receiver only gets snapshots taken at/after its join time.

const EPOCH_BITS = 2;
const LATENCY = 0.115; // measured 100-130 ms (was 0.15 hypothesis)

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rnd) {
  return Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
}

// Slot -> unit index.
//  carousel: units 0..N-1 then one extra slot re-sending a base unit (cycle length N+1). The extra slot
//            shifts the phase every cycle so a periodic sampler cannot miss the same units forever.
//  prio:     every `period`-th slot re-sends a unit from the base set [0, baseCount) (cyclic);
//            the other slots run the carousel above.
//  sqrt:     broadcast-scheduling square-root rule (Ammar & Wong; Vaidya & Hameed): unit i is sent with frequency
//            p_i ∝ sqrt(gain_i / size_i) (size = 1 packet), mixed with a uniform share alpha, realised deterministically
//            by stride scheduling (send the unit with the smallest pass value, then pass += 1/p_i).
function sqrtSchedule(N, gains, alpha) {
  const g = Array.from({ length: N }, (_, i) => (gains && Number.isFinite(gains[i]) ? Math.max(gains[i], 0) : NaN));
  const finite = g.filter(v => Number.isFinite(v) && v > 0);
  const maxG = finite.length ? Math.max(...finite) : 1, minG = finite.length ? Math.min(...finite) : 1;
  const f = g.map(v => Math.sqrt(Number.isNaN(v) ? 2 * maxG : Math.max(v, minG * 1e-3)));
  const sum = f.reduce((a, b) => a + b, 0);
  const p = f.map(v => (1 - alpha) * v / sum + alpha / N);
  const pass = new Float64Array(N), stride = p.map(v => 1 / v);
  const seq = [];
  // simple binary heap on (pass, index)
  const heap = Array.from({ length: N }, (_, i) => i);
  const less = (a, b) => pass[a] < pass[b] || (pass[a] === pass[b] && a < b);
  const down = i => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < N && less(heap[l], heap[m])) m = l; if (r < N && less(heap[r], heap[m])) m = r; if (m === i) return; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } };
  // initial passes: stride/2 so that high-frequency units start early, ties broken by gain order (index)
  for (let i = 0; i < N; i++) pass[i] = stride[i] / 2;
  for (let i = (N >> 1) - 1; i >= 0; i--) down(i);
  return k => {
    while (seq.length <= k) {
      const u = heap[0];
      seq.push(u);
      pass[u] += stride[u];
      down(0);
    }
    return seq[k];
  };
}

function makeSchedule(N, policy = { type: 'carousel' }, baseCount = 1, gains = null) {
  if (policy.type === 'sqrt') return sqrtSchedule(N, gains, policy.alpha || 0);
  const base = Math.max(1, Math.min(baseCount, N));
  const carousel = k => {
    const c = Math.floor(k / (N + 1)), i = k % (N + 1);
    return i < N ? i : c % base;
  };
  if (policy.type === 'carousel' || N <= 1) return carousel;
  if (policy.type === 'dual') {
    // units [0, baseCount) = thumbnail stream, [baseCount, N) = detail stream.
    // every period-th slot: next thumbnail unit (cyclic); other slots: detail carousel (cycle D+1, the extra
    // slot re-sends a thumbnail unit so the phase shifts every cycle).
    const T0 = Math.max(1, Math.min(baseCount, N)), D = N - T0, period = policy.period;
    return k => {
      const b = Math.floor(k / period);
      if (k % period === period - 1 || D <= 0) return b % T0;
      const j = k - b, c = Math.floor(j / (D + 1)), i = j % (D + 1);
      return i < D ? T0 + i : (c % T0);
    };
  }
  if (policy.type === 'tier') {
    // even slots: carousel over all units; odd slots: round robin over doubling tiers
    // [0,4), [4,12), [12,28), ... each tier cycling through its own units. A viewer joining at any time
    // gets the first 2^(j+2) units within about 2 * nTiers * 2^(j+2) slots.
    const tiers = [];
    for (let a = 0, size = 4; a < N; a += size, size *= 2) tiers.push([a, Math.min(N, a + size)]);
    const pos = new Int32Array(tiers.length);
    return k => {
      if (k % 2 === 0) return carousel(k / 2);
      const o = (k - 1) / 2;
      const t = o % tiers.length, round = Math.floor(o / tiers.length);
      const [a, b] = tiers[t];
      return a + (round % (b - a));
    };
  }
  if (policy.type === 'prio') {
    const period = policy.period;
    return k => {
      const b = Math.floor(k / period);
      if (k % period === period - 1) return b % base;
      return carousel(k - b);
    };
  }
  throw new Error('unknown policy ' + policy.type);
}

function sampleTimes(sampler, rnd, tEnd) {
  const out = [];
  if (sampler === 'nominal10') {
    const frame = 1 / 60;
    let tick = rnd() * 0.1;
    while (tick < tEnd) {
      out.push(Math.ceil(tick / frame) * frame);
      tick += Math.max(0.08, 0.1 + 0.004 * gauss(rnd));
    }
  } else if (sampler === 'bmfit') {
    let t = rnd() * 0.14;
    while (t < tEnd) { out.push(t); t += 0.1 + 0.08 * rnd(); }
  } else if (sampler === 'meas60') {
    // Fitted to in-game measurements 2026-09-17 (desktop, 60 fps, docs/measure/results-2026-09-17.md):
    // loss 11.4% at hold 80 ms, ~0% at >=100 ms; remote update intervals centred on 83-100 ms.
    // interval ~ U[70, 105] ms (mean 87.5 ms); rare hitches (0.1% of samples) add U[300, 900] ms.
    let t = rnd() * 0.0875;
    while (t < tEnd) {
      out.push(t);
      t += 0.07 + 0.035 * rnd();
      if (rnd() < 0.001) t += 0.3 + 0.6 * rnd();
    }
  } else if (sampler === 'congested') {
    // A crowded world, where remote parameter updates arrive far less often. NOT measured in game: a deliberately
    // pessimistic model (interval ~ U[120, 300] ms, hitches 20x more common) used to ask whether an encoding that
    // leans on primitives being complete degrades worse than one that does not (docs/research/08 §21).
    let t = rnd() * 0.21;
    while (t < tEnd) {
      out.push(t);
      t += 0.12 + 0.18 * rnd();
      if (rnd() < 0.02) t += 0.3 + 0.6 * rnd();
    }
  } else throw new Error('unknown sampler ' + sampler);
  return out;
}

function outages(rnd, tEnd) {
  const out = [];
  let t = -Math.log(rnd() + 1e-12) * 30 * rnd(); // random phase into an ON period
  while (t < tEnd) {
    const off = -Math.log(rnd() + 1e-12) * 4;
    out.push([t, t + off]);
    t += off - Math.log(rnd() + 1e-12) * 30;
  }
  return out;
}

// Receiver events: [{time (s after join), unit, prev (unit or -1), tearByte (0 = clean)}]
function arrivals({ schedule, H, channel, join, tMax, seed, packetBytes }) {
  const rnd = mulberry32(seed);
  const tEnd = join + tMax;
  const samples = sampleTimes(channel.sampler, rnd, tEnd);
  const outs = channel.burst ? outages(mulberry32(seed ^ 0x5bd1e995), tEnd) : [];
  const out = [];
  let lastSlot = -1, lastDelivered = -1, oi = 0;
  for (const s of samples) {
    const slot = Math.floor(s / H + 1e-9);
    const changed = slot !== lastSlot;
    const prevSlot = lastSlot;
    lastSlot = slot;
    const tornDraw = rnd(), jDraw = rnd();
    const t = s + LATENCY - join;
    if (s < join || t > tMax) continue;
    while (oi < outs.length && outs[oi][1] < s) oi++;
    if (oi < outs.length && outs[oi][0] <= s && s < outs[oi][1]) continue;
    if (slot === lastDelivered) continue; // this receiver already has this packet value
    let tearByte = 0, prev = -1;
    if (channel.torn && changed && prevSlot >= 0 && tornDraw < channel.torn) {
      tearByte = 1 + Math.floor(jDraw * (packetBytes - 1));
      prev = schedule(prevSlot);
    } else {
      lastDelivered = slot; // a torn value is followed by the clean value at the next snapshot
    }
    out.push({ time: t, unit: schedule(slot), prev, tearByte });
  }
  return out;
}

// CRC over a bit array (MSB-first LFSR). c in {4, 8}.
const POLY = { 4: 0x3, 8: 0x07 };
function crc(bits, c) {
  let r = 0;
  const top = 1 << (c - 1), mask = (1 << c) - 1;
  for (const b of bits) {
    const fb = ((r & top) ? 1 : 0) ^ b;
    r = (r << 1) & mask;
    if (fb) r ^= POLY[c];
  }
  return r;
}

module.exports = { EPOCH_BITS, LATENCY, makeSchedule, sqrtSchedule, arrivals, mulberry32, crc, sampleTimes };
