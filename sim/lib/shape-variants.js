'use strict';
// The representations compared in docs/research/08 (used by sim/shape-eval.js for numbers and sim/shape-sheets.js for
// pictures). Every variant gets the same packet budget; a cheaper primitive simply buys more primitives.
const primx = require('../codecs/primx');

const UNITS = 1000;                                                 // packets of primitives (plus unit 0)
const SOFT3 = [[0.35, 1], [0.7, 0.62], [1, 0.28]];                  // best edge from soft-eval (outline unchanged)
const DEEP = { nRand: 800, nClimb: 8, maxIter: 2000, maxAge: 200 }; // 4x the search of the default encoder

const VARIANTS = {
  base: { shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2 },                    // 58 bit (today)
  light: { shape: 'ell', cb: 8, rb: 6, ab: 5, col: [4, 4, 4], aBits: 2 },                   // 47 bit (format 4)
  circ43: { shape: 'ell', circle: true, cb: 9, rb: 7, col: [5, 6, 5], aBits: 2 },           // 43 bit
  circ39: { shape: 'ell', circle: true, cb: 9, rb: 7, col: [4, 4, 4], aBits: 2 },           // 39 bit
  circ34: { shape: 'ell', circle: true, cb: 8, rb: 5, col: [4, 4, 4], aBits: 1 },           // 34 bit (7 per packet)
  softbase: { shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, soft: [[0.5, 1], [1, 0.5]] },
  softcirc39: { shape: 'ell', circle: true, cb: 9, rb: 7, col: [4, 4, 4], aBits: 2, soft: [[0.5, 1], [1, 0.5]] },
  // order-independent additive blending (GaussianImage's "accumulated blending"): signed colour, no alpha field
  addhard: { shape: 'ell', cb: 9, rb: 8, ab: 6, col: [6, 6, 6], aBits: 0, blend: 'add' },
  addsoft: { shape: 'ell', cb: 9, rb: 8, ab: 6, col: [6, 6, 6], aBits: 0, blend: 'add', soft: [[0.4, 1], [0.9, 0.55], [1.6, 0.2]] },
  // same format as base, only more search per primitive (does the greedy search leave quality on the table?)
  deep: { shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, ...DEEP },
  // --- round 2: combinations of what helped (soft edge in3, light fields, deeper search)
  soft3: { shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, soft: SOFT3 },
  lightsoft: { shape: 'ell', cb: 8, rb: 6, ab: 5, col: [4, 4, 4], aBits: 2, soft: SOFT3 },
  lightdeep: { shape: 'ell', cb: 8, rb: 6, ab: 5, col: [4, 4, 4], aBits: 2, ...DEEP },
  deepsoft: { shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, soft: SOFT3, ...DEEP },
  lightsoftdeep: { shape: 'ell', cb: 8, rb: 6, ab: 5, col: [4, 4, 4], aBits: 2, soft: SOFT3, ...DEEP },
  // how far does more search go? (for "is more compute worth it")
  deeper: { shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, nRand: 2400, nClimb: 12, maxIter: 5000, maxAge: 400 },
  // --- round 3: strokes for text (the user's idea). 'cap' reads the very same fields as a capsule (thick line
  // segment), so the packet format does not change at all; 'mix' spends 1 bit per primitive on a type flag and lets
  // the encoder pick an ellipse or a capsule for each one (the angle pays for the bit).
  cap: { shape: 'cap', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2 },
  mix: { shape: 'mix', cb: 9, rb: 8, ab: 5, col: [5, 6, 5], aBits: 2 },
  capdeep: { shape: 'cap', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, ...DEEP },
  mixdeep: { shape: 'mix', cb: 9, rb: 8, ab: 5, col: [5, 6, 5], aBits: 2, ...DEEP },
  mixsoftdeep: { shape: 'mix', cb: 9, rb: 8, ab: 5, col: [5, 6, 5], aBits: 2, soft: SOFT3, ...DEEP },
};

// maxPrims chosen so that every variant uses the same number of units
function cfgFor(name, R, P) {
  const o = VARIANTS[name];
  if (!o) throw new Error('unknown variant: ' + name);
  const probe = { ...primx.cfgOf({ ...o, R, maxPrims: 4000 }), out: R };
  const L = primx.layout(probe, P);
  return { ...primx.cfgOf({ ...o, R, maxPrims: L.k0 + L.k * UNITS }), out: R };
}

module.exports = { VARIANTS, UNITS, SOFT3, DEEP, cfgFor };
