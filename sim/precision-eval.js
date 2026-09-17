'use strict';
// Reduced-precision prim variants (units encoded by the C# encoder into cache/precision, see results/precision-jobs.sh):
// quality over time with the default send order fast+sqrt/8 on the measured channel, for a viewer present from the start
// and one joining 30 s after the start.
//   node precision-eval.js eval <cache json>   -> results/precision/<name>.json (+ full render PNG next to the cache json)
//   node precision-eval.js summary            -> results/precision.md
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const M = require('./lib/metrics');
const T = require('./lib/transport');
const prim = require('./codecs/prim');
const { firstPassWith } = require('./lib/schedules-ff');

const TIMES = [5, 10, 20, 40, 60, 100, 150, 200, 300];
const JOINS = { start: 0, join30: 30 };
const SEEDS = 2;
const outDir = path.join(__dirname, 'results', 'precision');
const cacheDir = path.join(__dirname, 'cache', 'precision');

const cfgOf = j => ({ ...prim.cfgOf({ shape: 'ell', cb: j.cb, rb: j.rb, ab: j.ab, col: j.col, aBits: j.aBits, R: j.R, maxPrims: j.capacity || j.n }), out: j.R });

const [cmd, file] = process.argv.slice(2);
if (cmd === 'eval') {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file, '.json');                     // <image>-<variant>-n<n>
  const m = /^(.*)-([A-Z])-n(\d+)$/.exec(base);
  const [image, variant, n] = [m[1], m[2], Number(m[3])];
  const cfg = cfgOf(j), P = 8 * (j.bytes || 32) - 2, L = prim.layout(cfg, P);
  const units = j.units.map(s => [...s].map(Number));
  const gains = j.gains.map(g => (g === null ? Infinity : g));
  const N = units.length;
  const ref = I.loadPNG(path.join(__dirname, 'images', 'ref512', image + '.png'));
  const full = prim.decoder(cfg, P); units.forEach(u => full.apply(u));
  const fullImg = full.render();
  I.savePNG(fullImg, path.join(cacheDir, base + '.png'));
  const rows = { image, variant, n, label: j.cfg, primBits: L.primBits, k: L.k, units: N, lapSec: N / 10, prims: j.prims, encSec: j.encSec, full: M.all(ref, fullImg).msssimc, q: {} };
  for (const [jn, joinAt] of Object.entries(JOINS)) {
    const acc = TIMES.map(() => 0);
    for (let seed = 1; seed <= SEEDS; seed++) {
      const sq = () => T.makeSchedule(N, { type: 'sqrt', alpha: 0 }, 1, gains);
      const sched = firstPassWith(N, 8, sq(), sq());
      const arr = T.arrivals({ schedule: sched, H: 0.1, channel: { sampler: 'meas60', H: 0.1, torn: 0 }, join: joinAt, tMax: TIMES[TIMES.length - 1], seed: seed * 7919 + 13, packetBytes: 32 });
      const dec = prim.decoder(cfg, P); let ai = 0, got = 0;
      TIMES.forEach((t, k) => {
        while (ai < arr.length && arr[ai].time <= t) { dec.apply(units[arr[ai].unit]); ai++; got++; }
        acc[k] += (got ? M.all(ref, dec.render()).msssimc : 0) / SEEDS;
        if (seed === 1 && jn === 'start' && [10, 20, 60].includes(t) && ['screenshot_mahara', 'kodim23', 'illust_chibi'].includes(image))
          I.savePNG(dec.render(), path.join(cacheDir, `${base}-t${t}.png`));
      });
    }
    rows.q[jn] = acc;
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, base + '.json'), JSON.stringify(rows));
  console.log(`${base}: full ${rows.full.toFixed(4)}`);
} else if (cmd === 'summary') {
  const rows = fs.readdirSync(outDir).map(f => JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')));
  const keys = [...new Set(rows.map(r => `${r.variant}-${r.n}`))].sort();
  const mean = (sel, f) => sel.reduce((a, r) => a + f(r), 0) / sel.length;
  const reach = (q, level) => {
    if (q[0] >= level) return `≤${TIMES[0]}`;
    for (let k = 1; k < TIMES.length; k++) if (q[k] >= level) return (TIMES[k - 1] * Math.pow(TIMES[k] / TIMES[k - 1], (level - q[k - 1]) / (q[k] - q[k - 1]))).toFixed(0);
    return `>${TIMES[TIMES.length - 1]}`;
  };
  const nImg = new Set(rows.map(r => r.image)).size;
  const lines = [`# 座標・色の精度を落とした prim の比較（32 Int・キャンバス 512、テスト ${nImg} 枚、送り方 fast+sqrt/8、実測チャネル、${SEEDS} シード）`, '',
    'MS-SSIM (YCbCr 6:1:1、512 参照)。途中参加 = 開始 30 秒後に参加。秒数は参加時刻から。', '',
    '| 版 | 設定（座標.半径.角度-色α） | bit/図形 | 図形/パケット | 図形数 | パケット（1 周） | エンコード | 全部届いた画質 | 開始時から 0.90 / 0.95 まで | 開始時から 10 s / 20 s / 60 s | 30 s 後に参加 20 s / 60 s |',
    '|---|---|---:|---:|---:|---|---:|---:|---|---|---|'];
  for (const key of keys) {
    const sel = rows.filter(r => `${r.variant}-${r.n}` === key), r0 = sel[0];
    const qs = TIMES.map((_, k) => mean(sel, r => r.q.start[k])), qj = TIMES.map((_, k) => mean(sel, r => r.q.join30[k]));
    const at = (q, t) => q[TIMES.indexOf(t)].toFixed(3);
    lines.push(`| ${r0.variant} | ${r0.label.replace(/-r512-n\d+/, '')} | ${r0.primBits} | ${r0.k} | ${r0.n} | ${Math.round(mean(sel, r => r.units))}（${Math.round(mean(sel, r => r.lapSec))} s） | ${mean(sel, r => r.encSec).toFixed(1)} s | ${mean(sel, r => r.full).toFixed(3)} | ${reach(qs, 0.9)} / ${reach(qs, 0.95)} s | ${at(qs, 10)} / ${at(qs, 20)} / ${at(qs, 60)} | ${at(qj, 20)} / ${at(qj, 60)} |`);
  }
  fs.writeFileSync(path.join(__dirname, 'results', 'precision.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}
