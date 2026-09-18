'use strict';
// What a viewer present from the start sees after t seconds, for units encoded by the C# CLI
// (paramroom encode <image> --format 4 --out units.json). Same model as precision-eval.js:
// default send order fast+sqrt/8, 100 ms per packet, the measured channel (meas60, packet loss
// included), seed 1. Used for the BOOTH product images.
//   node progress-frames.js <units.json> <outPrefix> [t1,t2,...]   -> <outPrefix>-t05.png ...
const I = require('./lib/image');
const T = require('./lib/transport');
const prim = require('./codecs/prim');
const { firstPassWith } = require('./lib/schedules-ff');

const [file, prefix, list] = process.argv.slice(2);
const times = (list || '5,10,15,20,50,80').split(',').map(Number);
const j = require(require('path').resolve(file));
const cfg = { ...prim.cfgOf({ shape: 'ell', cb: j.cb, rb: j.rb, ab: j.ab, col: j.col, aBits: j.aBits, R: j.R, maxPrims: j.capacity || j.n }), out: j.R };
const P = 8 * (j.bytes || 32) - 2;
const units = j.units.map(s => [...s].map(Number));
const gains = j.gains.map(g => (g === null ? Infinity : g));
const N = units.length;

const sq = () => T.makeSchedule(N, { type: 'sqrt', alpha: 0 }, 1, gains);
const sched = firstPassWith(N, 8, sq(), sq());
const arr = T.arrivals({ schedule: sched, H: 0.1, channel: { sampler: 'meas60', H: 0.1, torn: 0 }, join: 0, tMax: Math.max(...times), seed: 1 * 7919 + 13, packetBytes: 32 });
const dec = prim.decoder(cfg, P);
const seen = new Set();
let ai = 0;
for (const t of times) {
  while (ai < arr.length && arr[ai].time <= t) { dec.apply(units[arr[ai].unit]); seen.add(arr[ai].unit); ai++; }
  const out = `${prefix}-t${String(t).padStart(2, '0')}.png`;
  I.savePNG(dec.render(), out);
  console.log(`${t} s: ${ai} packets arrived, ${seen.size}/${N} distinct units -> ${out}`);
}
