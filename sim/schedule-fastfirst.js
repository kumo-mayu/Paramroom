'use strict';
// Send-order candidates around a fast first pass (sim/lib/schedules-ff.js) for prim 512/4000: quality over time for
// viewers present from the start, joining during the first pass (10..90 s) and after it (150..300 s).
//   node schedule-fastfirst.js eval <image>   -> results/fastfirst/<image>.json   (uses cache/primscale/<image>-r512-n4000.json)
//   node schedule-fastfirst.js summary        -> results/fastfirst.md
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const M = require('./lib/metrics');
const T = require('./lib/transport');
const prim = require('./codecs/prim');
const { candidates } = require('./lib/schedules-ff');

const R = 512, NPRIM = 4000, SEEDS = 3;
const TIMES = [1, 2, 5, 10, 20, 40, 60, 120, 180, 300];
const JOINS = { start: () => 0, during: r => 10 + 80 * r, after: r => 150 + 150 * r };
const outDir = path.join(__dirname, 'results', 'fastfirst');
const cfg = { ...prim.cfgOf({ shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, R, maxPrims: NPRIM }), out: R };

const [cmd, image] = process.argv.slice(2);
if (cmd === 'eval') {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', 'primscale', `${image}-r512-n4000.json`), 'utf8'));
  const units = c.units.map(s => [...s].map(Number));
  const N = units.length;
  const ref = I.loadPNG(path.join(__dirname, 'images', 'ref512', image + '.png'));
  const ch = { sampler: 'meas60', H: 0.1, torn: 0 };
  const rows = [];
  const names = candidates(N, c.gains).map(([name]) => name);
  for (const sname of names) {
    for (const [jname, jf] of Object.entries(JOINS)) {
      const acc = TIMES.map(() => 0);
      for (let seed = 1; seed <= SEEDS; seed++) {
        const sched = candidates(N, c.gains).find(([n]) => n === sname)[1]; // fresh stateful schedule per run
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
  const rows = fs.readdirSync(outDir).filter(f => f.endsWith('.json')).flatMap(f => JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')));
  const n = new Set(rows.map(r => r.image)).size;
  const names = [...new Set(rows.map(r => r.schedule))];
  const mean = (s, j) => { const sel = rows.filter(r => r.schedule === s && r.join === j); return TIMES.map((_, k) => sel.reduce((a, r) => a + r.q[k], 0) / sel.length); };
  // time to reach a quality level (log-time interpolation), '>300' if never
  const reach = (q, level) => {
    if (q[0] >= level) return `≤${TIMES[0]}`;
    for (let k = 1; k < TIMES.length; k++) if (q[k] >= level) {
      const f = (level - q[k - 1]) / (q[k] - q[k - 1]);
      return (TIMES[k - 1] * Math.pow(TIMES[k] / TIMES[k - 1], f)).toFixed(0);
    }
    return `>${TIMES[TIMES.length - 1]}`;
  };
  const jl = { start: '開始時から視聴', during: '途中参加（1 周目の最中：開始 10〜90 秒後）', after: '途中参加（1 周目の後：開始 150〜300 秒後）' };
  const lines = [`# 送信順の比較（初回高速パスとその改良）：prim 512/4000、テスト ${n} 枚、実測チャネル meas60、各 ${SEEDS} シード`, '',
    '候補の定義は `sim/lib/schedules-ff.js`。MS-SSIM (YCbCr 6:1:1、512 参照)、時間は参加時刻からの経過秒。',
    '1 周目 = 1001 ユニット × 100 ms ≒ 100 秒（挟み込みのある候補は 1/(1-1/k) 倍に延びる）。', '',
    '## 画質が 0.80 / 0.90 / 0.95 に届くまでの秒数', '',
    `| 送信順 | ${Object.keys(JOINS).map(j => jl[j].replace(/（.*/, '') + (j === 'during' ? '（最中）' : j === 'after' ? '（後）' : '')).join(' | ')} |`, `|---|${Object.keys(JOINS).map(() => '---').join('|')}|`];
  for (const s of names) lines.push(`| ${s} | ${Object.keys(JOINS).map(j => { const q = mean(s, j); return [0.8, 0.9, 0.95].map(l => reach(q, l)).join(' / '); }).join(' | ')} |`);
  lines.push('');
  for (const j of Object.keys(JOINS)) {
    lines.push(`## ${jl[j]}`, '', `| 送信順 | ${TIMES.map(t => t + ' s').join(' | ')} |`, `|---|${TIMES.map(() => '---:').join('|')}|`);
    for (const s of names) lines.push(`| ${s} | ${mean(s, j).map(v => v.toFixed(3)).join(' | ')} |`);
    lines.push('');
  }
  fs.writeFileSync(path.join(__dirname, 'results', 'fastfirst.md'), lines.join('\n'));
  console.log(lines.join('\n'));
}
