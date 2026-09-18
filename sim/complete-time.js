'use strict';
// How long until a viewer present from the start has every unit, with the default send order
// fast+sqrt/8 at 100 ms/packet. Lossless channel vs the measured channel (meas60) over several seeds.
//   node complete-time.js <units.json> [seeds]
const T = require('./lib/transport');
const { firstPassWith } = require('./lib/schedules-ff');

const [file, seedsArg] = process.argv.slice(2);
const j = require(require('path').resolve(file));
const gains = j.gains.map(g => (g === null ? Infinity : g));
const N = j.units.length;
const sq = () => T.makeSchedule(N, { type: 'sqrt', alpha: 0 }, 1, gains);

function done(sampler, seed, share) {
  const sched = firstPassWith(N, 8, sq(), sq());
  // lossless: every slot arrives, slot k at (k + 1) * 100 ms
  const arr = sampler ? T.arrivals({ schedule: sched, H: 0.1, channel: { sampler, H: 0.1, torn: 0 }, join: 0, tMax: 600, seed, packetBytes: 32 })
    : Array.from({ length: 6000 }, (_, k) => ({ time: (k + 1) * 0.1, unit: sched(k) }));
  const seen = new Set();
  for (const a of arr) { seen.add(a.unit); if (seen.size >= Math.ceil(N * share)) return a.time; }
  return Infinity;
}

console.log(`units ${N} (1 lap at 100 ms = ${N / 10} s)`);
for (const share of [0.9, 0.95, 0.99, 1]) {
  const ideal = done(null, 1, share);
  const seeds = Number(seedsArg || 10);
  const meas = [];
  for (let s = 1; s <= seeds; s++) meas.push(done('meas60', s * 7919 + 13, share));
  meas.sort((a, b) => a - b);
  console.log(`${(share * 100).toFixed(0)}% of units: lossless ${ideal.toFixed(1)} s, measured channel median ${meas[Math.floor(seeds / 2)].toFixed(1)} s (min ${meas[0].toFixed(1)}, max ${meas[seeds - 1].toFixed(1)})`);
}
