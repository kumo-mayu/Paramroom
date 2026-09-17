'use strict';
// RAW: generalisation of vFeez/VRChat-OSC-Video (https://github.com/vFeez/VRChat-OSC-Video) for still images.
//
// Original: 16x14 grid, R/G/B each quantised to 2 bits (value // 64), 4 pixels per int parameter; one packet
// = one colour channel x one interlace field (even/odd rows), header = 3 bools (channel select + field flag),
// no sequence number, no CRC, a colour frame = 6 packets. Decoder = direct latch of pixel values.
// Here: grid g x g (square test images), `bits` per channel (uniform quantisation, mid-rise reconstruction),
// F interlace fields; static order = for field f: for channel c: rows y % F == f, raster; packed into units of
// whole pixels; unit id (u bits = ceil(log2(units))) replaces the original bools (same role, general size).
// order 'rows' = faithful (row interlace), order 'lattice' = 2D progressive lattice (step 8,4,2,1) per channel.
// Render: known value, else nearest known value in the same column (rows) / lattice ancestor, else mid grey;
// bilinear upscale to 256. Shader side: one texel per (pixel, channel), trivial latch; no transform.
const { BitWriter, BitReader } = require('../lib/bits');
const I = require('../lib/image');

function order(cfg) {
  const g = cfg.g, out = [];
  if (cfg.order === 'rows') {
    for (let f = 0; f < cfg.F; f++)
      for (let c = 0; c < 3; c++)
        for (let y = f; y < g; y += cfg.F)
          for (let x = 0; x < g; x++) out.push([c, y * g + x]);
  } else {
    const seen = [0, 1, 2].map(() => new Uint8Array(g * g));
    for (let s = 8; s >= 1; s >>= 1)
      for (let c = 0; c < 3; c++)
        for (let y = 0; y < g; y += s)
          for (let x = 0; x < g; x += s)
            if (!seen[c][y * g + x]) { seen[c][y * g + x] = 1; out.push([c, y * g + x]); }
  }
  return out;
}

const packCache = new Map();
function packing(cfg, P) {
  const key = `${cfg.label}/${P}`;
  if (packCache.has(key)) return packCache.get(key);
  const seq = order(cfg);
  for (let u = 1; u < 20; u++) {
    const per = Math.floor((P - u) / cfg.bits);
    if (per < 1) continue;
    const n = Math.ceil(seq.length / per);
    if (n <= (1 << u)) {
      const units = [];
      for (let i = 0; i < n; i++) units.push(seq.slice(i * per, (i + 1) * per));
      const res = { u, units };
      packCache.set(key, res);
      return res;
    }
  }
  throw new Error('raw: packing failed');
}

module.exports = {
  name: 'raw',
  configs(B) {
    const out = [];
    const add = (g, bits, ord, F = 2) => out.push({ label: `g${g}-b${bits}-${ord}${ord === 'rows' ? F : ''}`, g, bits, order: ord, F });
    add(16, 2, 'rows'); // original-like
    add(16, 3, 'lattice');
    add(32, 2, 'rows');
    add(32, 2, 'lattice');
    add(32, 3, 'lattice');
    add(64, 2, 'lattice');
    return out;
  },
  encode(ref, cfg, P) {
    const pk = packing(cfg, P);
    const small = I.resize(ref, cfg.g, cfg.g);
    const lv = (1 << cfg.bits) - 1;
    const units = pk.units.map((entries, id) => {
      const w = new BitWriter();
      w.write(id, pk.u);
      for (const [c, p] of entries) w.write(Math.max(0, Math.min(lv, Math.floor(small.data[p * 3 + c] / 256 * (lv + 1)))), cfg.bits);
      return w.bits;
    });
    // base = first colour field / coarse lattice (~1/F or 1/16 of the pixels)
    return { units, baseCount: Math.ceil(units.length / (cfg.order === 'rows' ? cfg.F : 16)) };
  },
  decoder(cfg, P) {
    const pk = packing(cfg, P);
    const g = cfg.g, lv = (1 << cfg.bits) - 1;
    const val = [0, 1, 2].map(() => new Int16Array(g * g).fill(-1));
    return {
      stateInfo: `${g}x${g}x3 latch (${cfg.bits} bits)`,
      apply(bits) {
        const r = new BitReader(bits);
        const id = r.read(pk.u);
        if (id >= pk.units.length) return;
        for (const [c, p] of pk.units[id]) val[c][p] = r.read(cfg.bits);
      },
      render() {
        const img = I.create(g, g, 3, 128);
        for (let c = 0; c < 3; c++)
          for (let y = 0; y < g; y++)
            for (let x = 0; x < g; x++) {
              let v = -1;
              if (cfg.order === 'rows') {
                for (let d = 0; d < g && v < 0; d++) {
                  if (y - d >= 0 && val[c][(y - d) * g + x] >= 0) v = val[c][(y - d) * g + x];
                  else if (y + d < g && val[c][(y + d) * g + x] >= 0) v = val[c][(y + d) * g + x];
                }
              } else {
                for (let s = 1; s <= 8 && v < 0; s <<= 1) v = val[c][(y - y % s) * g + (x - x % s)];
              }
              if (v >= 0) img.data[(y * g + x) * 3 + c] = (v + 0.5) * 256 / (lv + 1);
            }
        return I.quantize8(I.resize(img, 256, 256));
      },
    };
  },
};
