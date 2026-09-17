'use strict';
// Side-by-side renders of the sqrt schedule vs the fast first pass (prim 512/4000) at the same elapsed times, for a
// viewer present from the start or joining at --join seconds (measured channel model meas60, one seed).
// usage: node fastfirst-visual.js <outDir> [--join 30] [--times 5,10,20,40,60] [image ...]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const I = require('./lib/image');
const M = require('./lib/metrics');
const T = require('./lib/transport');
const prim = require('./codecs/prim');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const JOIN = Number(opt('join', 0));
const TIMES = opt('times', '5,10,20,40,60').split(',').map(Number);
const outDir = path.resolve(argv[0]);
const images = argv.slice(1).length ? argv.slice(1) : ['screenshot_mahara', 'kodim23'];
const cfg = { ...prim.cfgOf({ shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, R: 512, maxPrims: 4000 }), out: 512 };
const ffmpeg = require('../measure/analysis/node_modules/ffmpeg-static');
const font = 'C\\:/Windows/Fonts/YuGothB.ttc';
const esc = s => s.replace(/:/g, '\\:').replace(/'/g, "\\'");
fs.mkdirSync(outDir, { recursive: true });
const tmp = path.join(__dirname, 'cache', 'fastfirst-tiles');
fs.mkdirSync(tmp, { recursive: true });

for (const image of images) {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', 'primscale', `${image}-r512-n4000.json`), 'utf8'));
  const units = c.units.map(s => [...s].map(Number));
  const N = units.length;
  const ref = I.loadPNG(path.join(__dirname, 'images', 'ref512', image + '.png'));
  const sq1 = T.makeSchedule(N, { type: 'sqrt', alpha: 0 }, 1, c.gains), sq2 = T.makeSchedule(N, { type: 'sqrt', alpha: 0 }, 1, c.gains);
  const scheds = [['今の送り方（sqrt）', k => sq1(k)], ['fast（1 周目を高速に）', k => (k < N ? k : sq2(k - N))]];
  const files = [], labels = [];
  scheds.forEach(([name, sched], si) => {
    const arr = T.arrivals({ schedule: sched, H: 0.1, channel: { sampler: 'meas60', H: 0.1, torn: 0 }, join: JOIN, tMax: Math.max(...TIMES), seed: 7919 + 13, packetBytes: 32 });
    const dec = prim.decoder(cfg, 254); let ai = 0; const got = new Set();
    for (const t of TIMES) {
      while (ai < arr.length && arr[ai].time <= t) { dec.apply(units[arr[ai].unit]); got.add(arr[ai].unit); ai++; }
      const r = dec.render();
      const p = path.join(tmp, `${image}-${JOIN}-${si}-${t}.png`);
      I.savePNG(I.resize(r, 384, 384), p);
      files.push(p);
      labels.push(`${name}　${JOIN ? "参加から " : ""}${t} 秒（${got.size}/${N} ユニット、${M.all(ref, r).msssimc.toFixed(3)}）`);
    }
  });
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  files.forEach(f => args.push('-i', f));
  const chains = files.map((_, i) => `[${i}:v]pad=384:418:0:34:white,drawtext=fontfile='${font}':text='${esc(labels[i])}':x=6:y=8:fontsize=13:fontcolor=black[t${i}]`);
  const layout = files.map((_, i) => `${(i % TIMES.length) * 384}_${Math.floor(i / TIMES.length) * 418}`).join('|');
  const filter = chains.join(';') + `;${files.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=white[out]`;
  args.push('-filter_complex', filter, '-map', '[out]', '-frames:v', '1', path.join(outDir, `${image}-sqrt-vs-fast${JOIN ? "-join" + JOIN : ""}.png`));
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  console.log(`wrote ${image}-sqrt-vs-fast.png`);
}
