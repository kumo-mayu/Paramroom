'use strict';
// Simulated counterpart of the in-game prim test (send-image.js defaults): kodim23, prim e9.8.6-c565a2-r256-n1000,
// sqrt schedule over all units, hold 100 ms, meas60 sampler, no torn packets. Prints MS-SSIM (YCbCr 6:1:1)
// of the partial render vs the full render and vs the source, averaged over seeds, for a start join and a late join.
// usage: node sim-prim-live.js [--join 126] [--seeds 20]
const path = require('path');
const I = require('../../sim/lib/image');
const M = require('../../sim/lib/metrics');
const T = require('../../sim/lib/transport');
const prim = require('../../sim/codecs/prim');
const { padBits } = require('../../sim/lib/evaluate');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const lateJoin = Number(opt('join', 126)), seeds = Number(opt('seeds', 20));
const TIMES = [0.5, 1, 2, 5, 10, 20, 40, 60];

let img = I.loadPNG(path.resolve(__dirname, '../../sim/images/ref/kodim23.png'));
const s = Math.min(img.w, img.h);
img = I.resize(I.crop(img, (img.w - s) >> 1, (img.h - s) >> 1, s, s), 256, 256);
const cfg = prim.configs(256).find(c => c.label === 'e9.8.6-c565a2-r256-n1000');
const P = 254;
const enc = prim.encode(img, cfg, P);
const payloads = enc.units.map(u => padBits(u, P));
const N = payloads.length;
const full = prim.decoder(cfg, P); payloads.forEach(p => full.apply(p));
const fullImg = full.render();
const schedule = T.makeSchedule(N, { type: 'sqrt', alpha: 0 }, 1, enc.gains);
const ch = { sampler: 'meas60', H: 0.1, torn: 0 };

console.log(`units ${N}; full render vs source msssimc ${M.all(img, fullImg).msssimc.toFixed(4)}`);
for (const join of [0, lateJoin]) {
  const acc = TIMES.map(() => ({ full: 0, src: 0, got: 0 }));
  for (let seed = 1; seed <= seeds; seed++) {
    const arr = T.arrivals({ schedule, H: ch.H, channel: ch, join, tMax: 60, seed: seed * 7919 + 13, packetBytes: 32 });
    const dec = prim.decoder(cfg, P);
    const got = new Set();
    let ai = 0;
    TIMES.forEach((t, k) => {
      while (ai < arr.length && arr[ai].time <= t) { dec.apply(payloads[arr[ai].unit]); got.add(arr[ai].unit); ai++; }
      const r = got.size ? dec.render() : I.create(256, 256, 3, 128);
      acc[k].full += M.all(fullImg, r).msssimc; acc[k].src += M.all(img, r).msssimc; acc[k].got += got.size;
    });
  }
  console.log(`join ${join} s`);
  TIMES.forEach((t, k) => console.log(`  +${t}s  units ${(acc[k].got / seeds).toFixed(0)}  vsFull ${(acc[k].full / seeds).toFixed(4)}  vsSrc ${(acc[k].src / seeds).toFixed(4)}`));
}
