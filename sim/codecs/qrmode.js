'use strict';
// QR mode: the same packets carry a QR code's modules instead of primitives (docs/research/09).
//
// Why it fits without changing anything: the decoder already stores each unit's payload as fixed-width slots (one per
// primitive, primBits data bits plus an "arrived" flag). A QR code is just a bit per module, so the modules go into the
// very same slots, primBits of them at a time. The shader only needs a different way to turn a canvas pixel into a
// colour; the packet layout, the store, the epoch handling and the aspect code are untouched.
//
//   unit 0: [unit id u][header 16][slots k0 x primBits]
//   unit i: [unit id u][slots k x primBits]
//   header: [modules 8][reserved 8]     modules = 21..177, the side of the QR code
//   payload bits: module (mx, my) is bit my * modules + mx, row by row
//   spare bits of every packet: [mode 1][aspect 8]   mode 1 = QR, 0 = primitives
//
// A canvas pixel is white unless its module's slot has arrived and its bit is 1. A module whose packet is missing stays
// white, which a reader treats as unreadable rather than reading something wrong.
const { BitReader } = require('../lib/bits');

const QUIET = 4;   // modules of white margin around the code, as the QR standard asks for

// the same layout maths as prim.js, so a packet built here fits the decoder built for primitives
function layout(cfg, P) {
  const primBits = cfg.primBits;
  for (let u = 1; u <= 16; u++) {
    const pay = P - u;
    if (primBits > pay) continue;
    const k = Math.floor(pay / primBits), k0 = Math.max(0, Math.floor((pay - 16) / primBits));
    const maxPrims = k0 + Math.ceil(Math.max(0, cfg.maxPrims - k0) / k) * k;
    const units = 1 + (maxPrims - k0) / k;
    if (units <= (1 << u)) return { u, pay, k, k0, units, maxPrims, primBits };
  }
  throw new Error('qrmode: cannot fit');
}

// how many units a code of n modules needs
function unitsNeeded(L, n) {
  const bits = n * n;
  if (bits <= L.k0 * L.primBits) return 1;
  return 1 + Math.ceil((bits - L.k0 * L.primBits) / (L.k * L.primBits));
}

// modules (a Uint8Array of n*n, 1 = black) -> units, each a bool array of P bits
function encode(modules, n, cfg, P, aspect = 128) {
  const L = layout(cfg, P);
  const need = unitsNeeded(L, n);
  if (need > L.units) throw new Error(`qrmode: ${n}x${n} needs ${need} units, the decoder holds ${L.units}`);
  const units = [];
  let bit = 0;                    // next module bit to place
  for (let id = 0; id < need; id++) {
    const b = [];
    for (let i = L.u - 1; i >= 0; i--) b.push((id >>> i) & 1);
    if (id === 0) {
      for (let i = 7; i >= 0; i--) b.push((n >>> i) & 1);
      for (let i = 0; i < 8; i++) b.push(0);      // reserved
    }
    const slots = id === 0 ? L.k0 : L.k;
    for (let s = 0; s < slots; s++) {
      for (let i = 0; i < L.primBits; i++) b.push(bit < n * n ? modules[bit++] : 0);
    }
    while (b.length < P) b.push(0);
    // spare bits at the end: mode then the aspect code (1:1 for a QR code)
    b[P - 9] = 1;
    for (let i = 0; i < 8; i++) b[P - 8 + i] = (aspect >> (7 - i)) & 1;
    units.push(b);
  }
  return { units, unitsUsed: need, layout: L };
}

// what the shader draws: R x R pixels, white margin of QUIET modules, black where a module's bit is 1
function decoder(cfg, P) {
  const L = layout(cfg, P);
  const R = cfg.R;
  const store = new Array(1 << L.u).fill(null);
  return {
    apply(bits) {
      const rd = new BitReader(bits);
      const id = rd.read(L.u);
      if (id >= L.units) return;
      store[id] = bits.slice(L.u, L.u + L.pay);
    },
    // the module count the header says (0 when unit 0 has not arrived)
    get modules() {
      if (!store[0]) return 0;
      const rd = new BitReader(store[0]);
      return rd.read(8);
    },
    render() {
      const n = this.modules;
      const img = { w: R, h: R, c: 3, data: new Float64Array(R * R * 3).fill(255) };
      if (n < 21) return img;                      // nothing to draw yet
      const cells = n + 2 * QUIET;
      const cell = Math.floor(R / cells);
      if (cell < 1) return img;
      const pad = Math.floor((R - cell * cells) / 2);
      for (let my = 0; my < n; my++) {
        for (let mx = 0; mx < n; mx++) {
          const idx = my * n + mx;
          const slot = Math.floor(idx / L.primBits), off = idx % L.primBits;
          // slot -> unit and position, the same mapping the decoder uses for primitives
          const unit = slot < L.k0 ? 0 : 1 + Math.floor((slot - L.k0) / L.k);
          const inUnit = slot < L.k0 ? slot : (slot - L.k0) % L.k;
          const payload = store[unit];
          if (!payload) continue;                  // not arrived: leave white
          const base = (unit === 0 ? 16 : 0) + inUnit * L.primBits + off;
          if (!payload[base]) continue;            // white module
          const x0 = pad + (QUIET + mx) * cell, y0 = pad + (QUIET + my) * cell;
          for (let y = y0; y < y0 + cell; y++) {
            for (let x = x0; x < x0 + cell; x++) {
              const o = (y * R + x) * 3;
              img.data[o] = img.data[o + 1] = img.data[o + 2] = 0;
            }
          }
        }
      }
      return img;
    },
  };
}

module.exports = { QUIET, layout, unitsNeeded, encode, decoder };
