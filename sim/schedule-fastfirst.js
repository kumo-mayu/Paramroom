'use strict';
// "Fast first pass" schedules for prim 512/4000: send every unit once in greedy order (no repeats, best for viewers
// present from the start), then continue with the square-root rule (good for late joiners). Compared with the current
// sqrt schedule and a plain carousel, for viewers joining at the start, during the first pass and after it.
//   node schedule-fastfirst.js eval <image>   -> results/fastfirst/<image>.json   (uses cache/primscale/<image>-r512-n4000.json)
//   node schedule-fastfirst.js summary        -> results/fastfirst.md
// Schedules:
//   sqrt       square-root rule from the start (current sender)
//   carousel   units 0..N-1 repeated
//   fast       first N slots = units 0..N-1, then sqrt
//   fast3:1    first pass with every 4th slot taken by the sqrt rule, then sqrt
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const M = require('./lib/metrics');
const T = require('./lib/transport');
const prim = require('./codecs/prim');

const R = 512, NPRIM = 4000, SEEDS = 3;
const TIMES = [1, 2, 5, 10, 20, 40, 60, 120, 180, 300];
const JOINS = { start: () => 0, during: r => 10 + 80 * r, after: r => 150 + 150 * r };
const outDir = path.join(__dirname, 'results', 'fastfirst');
const cfg = { ...prim.cfgOf({ shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, R, maxPrims: NPRIM }), out: R };

function schedules(N, gains) {
  const sq = () => T.makeSchedule(N, { type: 'sqrt', alpha: 0 }, 1, gains);
  const s1 = sq(), s2 = sq(), s3 = sq();
  return {
    sqrt: k => s1(k),
    carousel: k => k % N,
    fast: k => (k < N ? k : s2(k - N)),
    'fast3:1': (() => {
      const firstLen = Math.ceil(N * 4 / 3);
      let sqK = 0; const seq = [];
      return k => {
        while (seq.length <= k) {
          const j = seq.length;
          if (j < firstLen && j % 4 !== 3) seq.push(Math.min(N - 1, j - Math.floor(j / 4)));
          else seq.push(s3(sqK++));
        }
        return seq[k];
      };
    })(),
  };
}

const [cmd, image] = process.argv.slice(2);
if (cmd === 'eval') {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', 'primscale', `${image}-r512-n4000.json`), 'utf8'));
  const units = c.units.map(s => [...s].map(Number));
  const N = units.length;
  const ref = I.loadPNG(path.join(__dirname, 'images', 'ref512', image + '.png'));
  const ch = { sampler: 'meas60', H: 0.1, torn: 0 };
  const rows = [];
  for (const [sname, sched] of Object.entries(schedules(N, c.gains))) {
    for (const [jname, jf] of Object.entries(JOINS)) {
      const acc = TIMES.map(() => 0);
      for (let seed = 1; seed <= SEEDS; seed++) {
        const join = jf(T.mulberry32(seed * 104729 + 7)());
        const arr = T.arrivals({ schedule: sched, H: ch.H, channel: ch, join, tMax: TIMES[TIMES.length - 1], seed: seed * 7919 + 13, packetBytes: 32 });
        const dec = prim.decoder(cfg, 254); let ai = 0, got = 0;
        TIMES.forEach((t, k) => {
          while (ai < arr.length && arr[ai].time <= t) { dec.apply(units[arr[ai].unit]); ai++; got++; }
          acc[k] += (got ? M.all(ref, dec.render()).msssimc : 0) / SEEDS;
        });
      }
      rows.push({ image, schedule: sname, join: jname, q: acc });
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, image + '.json'), JSON.stringify(rows));
  console.log(`${image} done`);
} else if (cmd === 'summary') {
  const rows = fs.readdirSync(outDir).flatMap(f => JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')));
  const n = new Set(rows.map(r => r.image)).size;
  const lines = [`# 初回高速パス（fast first）の評価：prim 512/4000、テスト ${n} 枚、実測チャネル meas60、各 ${SEEDS} シード`, '',
    'MS-SSIM (YCbCr 6:1:1、512 参照)。時間は参加時刻からの経過。途中参加（初回パス中）= 開始 10〜90 秒後、途中参加（初回パス後）= 開始 150〜300 秒後。', ''];
  const jl = { start: '開始時から視聴', during: '途中参加（初回パス中）', after: '途中参加（初回パス後）' };
  for (const j of Object.keys(JOINS)) {
    lines.push(`## ${jl[j]}`, '', `| 送信順 | ${TIMES.map(t => t + ' s').join(' | ')} |`, `|---|${TIMES.map(() => '---:').join('|')}|`);
    for (const s of ['sqrt', 'carousel', 'fast', 'fast3:1']) {
      const sel = rows.filter(r => r.schedule === s && r.join === j);
      lines.push(`| ${s} | ${TIMES.map((_, k) => (sel.reduce((a, r) => a + r.q[k], 0) / sel.length).toFixed(3)).join(' | ')} |`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(__dirname, 'results', 'fastfirst.md'), lines.join('\n'));
  console.log(lines.join('\n'));
}
