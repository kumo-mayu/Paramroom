'use strict';
// Scaling study for the prim codec (256 bit): more primitives (n) and a larger canvas (R = 512).
//   node prim-scale.js encode <image> <R> <n>   -> cache/primscale/<image>-r<R>-n<n>.json (units, gains, encode time)
//   node prim-scale.js eval <image> <R> <n>     -> results/primscale.jsonl (one row per join/time)
//   node prim-scale.js summary                  -> results/primscale.md
// Channel: measured model (meas60 sampler, hold 100 ms, no torn packets = OSC bundle), sqrt schedule over all units
// (as measure/osc/send-image.js). Joins: at the start, and late (150..300 s after the start).
// Quality: MS-SSIM (YCbCr 6:1:1) of the render against the 256 reference (512 renders downscaled) and against the
// 512 reference (256 renders upscaled), so both canvases are compared on the same references.
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const M = require('./lib/metrics');
const T = require('./lib/transport');
const prim = require('./codecs/prim');
const { padBits } = require('./lib/evaluate');

const P = 254;
const TIMES = [1, 2, 5, 10, 20, 40, 60, 120, 180, 300];
const SEEDS = 4;
const cacheDir = path.join(__dirname, 'cache', 'primscale');
const outFile = path.join(__dirname, 'results', 'primscale.jsonl');
const cfgFor = (R, n) => ({ ...prim.cfgOf({ shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, R, maxPrims: n }), out: R });
const refOf = (image, size) => I.loadPNG(path.join(__dirname, 'images', size === 256 ? 'ref' : 'ref' + size, image + '.png'));

const [cmd, image, Rs, ns] = process.argv.slice(2);
const R = Number(Rs), n = Number(ns);
const cacheFile = () => path.join(cacheDir, `${image}-r${R}-n${n}.json`);

if (cmd === 'encode') {
  fs.mkdirSync(cacheDir, { recursive: true });
  const cfg = cfgFor(R, n);
  const t0 = Date.now();
  const enc = prim.encode(refOf(image, R), cfg, P);
  const L = prim.layout(cfg, P);
  fs.writeFileSync(cacheFile(), JSON.stringify({ image, R, n, encSec: (Date.now() - t0) / 1000, layout: L, units: enc.units.map(u => padBits(u, P).join('')), gains: enc.gains }));
  console.log(`${image} R${R} n${n}: ${enc.units.length} units, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} else if (cmd === 'eval') {
  const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  const cfg = cfgFor(R, n);
  const units = c.units.map(s => [...s].map(Number));
  const N = units.length;
  const ref256 = refOf(image, 256), ref512 = refOf(image, 512);
  const schedule = T.makeSchedule(N, { type: 'sqrt', alpha: 0 }, 1, c.gains);
  const ch = { sampler: 'meas60', H: 0.1, torn: 0 };
  const grey = I.create(R, R, 3, 128);
  const score = img => {
    const a = R === 256 ? img : I.resize(img, 256, 256), b = R === 512 ? img : I.resize(img, 512, 512);
    return { q256: M.all(ref256, a).msssimc, q512: M.all(ref512, b).msssimc };
  };
  const full = prim.decoder(cfg, P); units.forEach(u => full.apply(u));
  const fs0 = score(full.render());
  const rows = [];
  for (const joinType of ['start', 'late']) {
    const acc = TIMES.map(() => ({ q256: 0, q512: 0, got: 0 }));
    for (let seed = 1; seed <= SEEDS; seed++) {
      const join = joinType === 'start' ? 0 : 150 + 150 * T.mulberry32(seed * 104729 + 7)();
      const arr = T.arrivals({ schedule, H: ch.H, channel: ch, join, tMax: TIMES[TIMES.length - 1], seed: seed * 7919 + 13, packetBytes: 32 });
      const dec = prim.decoder(cfg, P), got = new Set();
      let ai = 0;
      TIMES.forEach((t, k) => {
        while (ai < arr.length && arr[ai].time <= t) { dec.apply(units[arr[ai].unit]); got.add(arr[ai].unit); ai++; }
        const s = score(got.size ? dec.render() : grey);
        acc[k].q256 += s.q256 / SEEDS; acc[k].q512 += s.q512 / SEEDS; acc[k].got += got.size / SEEDS;
      });
    }
    TIMES.forEach((t, k) => rows.push({ image, R, n, N, encSec: c.encSec, join: joinType, t, q256: +acc[k].q256.toFixed(4), q512: +acc[k].q512.toFixed(4), got: +acc[k].got.toFixed(1), full256: +fs0.q256.toFixed(4), full512: +fs0.q512.toFixed(4) }));
  }
  fs.appendFileSync(outFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`${image} R${R} n${n}: eval done`);
} else if (cmd === 'summary') {
  const rows = fs.readFileSync(outFile, 'utf8').trim().split('\n').map(JSON.parse);
  const keys = [...new Set(rows.map(r => `${r.R}/${r.n}`))].sort((a, b) => { const [ra, na] = a.split('/').map(Number), [rb, nb] = b.split('/').map(Number); return ra - rb || na - nb; });
  const images = [...new Set(rows.map(r => r.image))];
  const mean = (arr, f) => arr.reduce((s, r) => s + f(r), 0) / arr.length;
  const lines = ['# prim の図形数・キャンバス解像度スケーリング（256 bit、実測チャネル meas60、平方根則、OSC バンドル）', '',
    `テスト画像 ${images.length} 枚、各 ${SEEDS} シード。途中参加 = 開始 150〜300 秒後に参加。MS-SSIM (YCbCr 6:1:1)。`,
    'q256 = 256 参照との比較（512 描画は縮小）、q512 = 512 参照との比較（256 描画は拡大）。', ''];
  for (const metric of ['q256', 'q512']) {
    for (const join of ['start', 'late']) {
      lines.push(`## ${metric}・${join === 'start' ? '開始時から視聴' : '途中参加'}`, '');
      lines.push(`| R / 図形数 | ユニット | エンコード秒 | ${TIMES.map(t => t + ' s').join(' | ')} | 全ユニット |`);
      lines.push(`|---|---:|---:|${TIMES.map(() => '---:').join('|')}|---:|`);
      for (const k of keys) {
        const [Rk, nk] = k.split('/').map(Number);
        const sel = rows.filter(r => r.R === Rk && r.n === nk && r.join === join);
        const cells = TIMES.map(t => mean(sel.filter(r => r.t === t), r => r[metric]).toFixed(3));
        const one = sel.filter(r => r.t === TIMES[0]);
        lines.push(`| ${Rk} / ${nk} | ${mean(one, r => r.N).toFixed(0)} | ${mean(one, r => r.encSec).toFixed(0)} | ${cells.join(' | ')} | ${mean(one, r => r['full' + metric.slice(1)]).toFixed(3)} |`);
      }
      lines.push('');
    }
  }
  fs.writeFileSync(path.join(__dirname, 'results', 'primscale.md'), lines.join('\n'));
  console.log(lines.join('\n'));
}
