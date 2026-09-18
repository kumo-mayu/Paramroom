'use strict';
// Same number of packets, different primitive descriptions (docs/research/07).
// The resource is bits, not primitives: a packet holds 4 of today's 58-bit ellipses, but 6 circles of 39 bits. So every
// variant here is given the SAME unit (packet) budget and is free to spend it on more, cheaper primitives.
//   node shape-eval.js encode <image> <variant>   -> cache/shape/<image>-<variant>.json
//   node shape-eval.js eval   <image> <variant>   -> results/shapeeval.jsonl
//   node shape-eval.js summary                    -> results/shapeeval.md
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const M = require('./lib/metrics');
const primx = require('./codecs/primx');
const { padBits } = require('./lib/evaluate');

const P = 254;
const R = Number(process.env.PARAMROOM_R || 512);  // 512 by default; PARAMROOM_R=1024 for the bigger canvas study
const FRACS = [0.05, 0.15, 0.4, 1];

const { VARIANTS, cfgFor: variantCfg } = require('./lib/shape-variants');
// PARAMROOM_UNITS: packets of primitives (default 1000 = the 100 s cycle of today's 512/4000). Fewer packets means
// fewer primitives but a faster cycle, which matters for people who arrive late (docs/research/08 §19).
const UNITS = Number(process.env.PARAMROOM_UNITS || 1000);

const cacheDir = path.join(__dirname, 'cache', 'shape');
const outFile = path.join(__dirname, 'results', 'shapeeval.jsonl');
const [cmd, image, variant] = process.argv.slice(2);

const cfgFor = name => variantCfg(name, R, P, UNITS);
const cacheFile = (img = image, v = variant) => path.join(cacheDir, `${img}-${v}${R === 512 ? '' : '-r' + R}${UNITS === 1000 ? '' : '-u' + UNITS}.json`);
const refOf = img => I.loadPNG(path.join(__dirname, 'images', 'ref' + R, img + '.png'));

if (cmd === 'encode') {
  fs.mkdirSync(cacheDir, { recursive: true });
  const cfg = cfgFor(variant);
  const L = primx.layout(cfg, P);
  const t0 = Date.now();
  const enc = primx.encode(refOf(image), cfg, P);
  fs.writeFileSync(cacheFile(), JSON.stringify({
    image, variant, R, primBits: L.primBits, k: L.k, maxPrims: L.maxPrims, encSec: (Date.now() - t0) / 1000,
    units: enc.units.map(u => padBits(u, P).join('')), gains: enc.gains,
  }));
  console.log(`${image} ${variant}: ${L.primBits} bit x ${L.maxPrims} prims in ${enc.units.length} units, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} else if (cmd === 'eval') {
  const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  const cfg = cfgFor(variant);
  const units = c.units.map(s => [...s].map(Number));
  const ref = refOf(image);
  const order = c.gains.map((g, i) => [i, g === null ? Infinity : g]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const rows = [];
  for (const f of FRACS) {
    const k = Math.max(1, Math.round(units.length * f));
    const dec = primx.decoder(cfg, P);
    for (const u of order.slice(0, k)) dec.apply(units[u]);
    rows.push({ image, variant, primBits: c.primBits, prims: c.maxPrims, N: units.length, encSec: c.encSec, frac: f, units: k, q: +M.all(ref, dec.render()).msssimc.toFixed(4) });
  }
  fs.appendFileSync(outFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(rows.map(r => `${r.image} ${r.variant} f=${r.frac}: ${r.q}`).join('\n'));
} else if (cmd === 'time') {
  // the real thing: fast+sqrt/8 over the measured channel (hold 100 ms, no torn packets), for a viewer present from the
  // start, one who joins during the first pass, and one who joins long after it
  const T = require('./lib/transport');
  const FF = require('./lib/schedules-ff');
  const TIMES = [5, 10, 20, 40, 80, 150];
  const SEEDS = 2;
  const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  const cfg = cfgFor(variant);
  const units = c.units.map(s => [...s].map(Number));
  const N = units.length;
  const ref = refOf(image);
  const ch = { sampler: 'meas60', H: 0.1, torn: 0 };
  const grey = I.create(R, R, 3, 128);
  const rows = [];
  for (const [joinType, joinOf] of [['start', () => 0], ['mid', () => 30], ['late', s => 150 + 150 * T.mulberry32(s * 104729 + 7)()]]) {
    const acc = TIMES.map(() => 0);
    for (let seed = 1; seed <= SEEDS; seed++) {
      const schedule = FF.firstPassWith(N, 8, T.makeSchedule(N, { type: 'sqrt', alpha: 0 }, 1, c.gains), T.makeSchedule(N, { type: 'sqrt', alpha: 0 }, 1, c.gains));
      const join = joinOf(seed);
      const arr = T.arrivals({ schedule, H: ch.H, channel: ch, join, tMax: TIMES[TIMES.length - 1], seed: seed * 7919 + 13, packetBytes: 32 });
      const dec = primx.decoder(cfg, P);
      let ai = 0, got = 0;
      TIMES.forEach((t, k) => {
        while (ai < arr.length && arr[ai].time <= t) { dec.apply(units[arr[ai].unit]); got++; ai++; }
        acc[k] += M.all(ref, got ? dec.render() : grey).msssimc / SEEDS;
      });
    }
    TIMES.forEach((t, k) => rows.push({ image, variant, join: joinType, t, q: +acc[k].toFixed(4) }));
  }
  fs.appendFileSync(path.join(__dirname, 'results', 'shapetime.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`${image} ${variant}: time done`);
} else if (cmd === 'timesummary') {
  const rows = fs.readFileSync(path.join(__dirname, 'results', 'shapetime.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const TIMES = [...new Set(rows.map(r => r.t))].sort((a, b) => a - b);
  const vars = [...new Set(rows.map(r => r.variant))];
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const lines = ['# 実測チャネル・fast+sqrt/8 での時間変化', '',
    `画像 ${[...new Set(rows.map(r => r.image))].length} 枚、2 シード。join=start は最初から居る人、mid は開始 30 秒後（1 周目の途中）、late は 150〜300 秒後の参加。`, ''];
  for (const join of ['start', 'mid', 'late']) {
    lines.push(`## ${join}`, '', '| 表現 | ' + TIMES.map(t => `${t} 秒`).join(' | ') + ' |', '|---|' + TIMES.map(() => '---:').join('|') + '|');
    for (const v of vars) lines.push(`| ${v} | ` + TIMES.map(t => {
      const g = rows.filter(r => r.variant === v && r.join === join && r.t === t);
      return g.length ? mean(g.map(r => r.q)).toFixed(4) : '-';
    }).join(' | ') + ' |');
    lines.push('');
  }
  const out = path.join(__dirname, 'results', 'shapetime.md');
  fs.writeFileSync(out, lines.join('\n'));
  console.log(lines.join('\n'));
} else if (cmd === 'summary') {
  // The jsonl is append-only and a re-run adds new rows, so keep only the last row of each (image, variant, frac) -
  // otherwise a variant that was measured twice is counted twice and its average is wrong. Images whose name ends in
  // _full belong to a separate study (a whole page stretched into the canvas, docs/research/08 §17).
  const all = fs.readFileSync(outFile, 'utf8').trim().split('\n').map(JSON.parse).filter(r => !r.image.endsWith('_full'));
  const dedup = new Map();
  for (const r of all) dedup.set(`${r.image}|${r.variant}|${r.frac}`, r);
  const rows = [...dedup.values()];
  const images = [...new Set(rows.map(r => r.image))];
  const vars = Object.keys(VARIANTS).filter(v => rows.some(r => r.variant === v));
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const get = (v, f) => rows.filter(r => r.variant === v && r.frac === f);
  const lines = ['# パケット数を揃えた図形表現の比較', '',
    `キャンバス ${R}、パケット ${UNITS + 1} 個（= 現行 512/4000 と同じ通信量）。MS-SSIM (YCbCr 6:1:1)。`,
    'f は「誤差削減の大きいパケットから f 割合だけ届いた状態」。', '',
    '**行ごとに平均した画像の枚数が違う**（後から枚数を増やした表現がある）ので、枚数の列を必ず見ること。', '',
    '| 表現 | 1 図形 | 図形数 | 枚数 | ' + FRACS.map(f => `f=${f}`).join(' | ') + ' | 符号化時間 |',
    '|---|---:|---:|---:|' + FRACS.map(() => '---:').join('|') + '|---:|'];
  for (const v of vars) {
    const one = get(v, 1);
    lines.push(`| ${v} | ${one[0].primBits} bit | ${one[0].prims} | ${one.length} | ` +
      FRACS.map(f => { const g = get(v, f); return g.length ? mean(g.map(r => r.q)).toFixed(4) : '-'; }).join(' | ') +
      ` | ${mean(one.map(r => r.encSec)).toFixed(0)} s |`);
  }
  lines.push('', '## 画像ごと（全部届いたとき）', '', '| 画像 | ' + vars.join(' | ') + ' |', '|---|' + vars.map(() => '---:').join('|') + '|');
  for (const img of images) lines.push(`| ${img} | ` + vars.map(v => { const r = rows.find(x => x.image === img && x.variant === v && x.frac === 1); return r ? r.q.toFixed(4) : '-'; }).join(' | ') + ' |');
  lines.push('', '各表現の中身：', '', ...vars.map(v => {
    const o = VARIANTS[v];
    return `- \`${v}\`: ${o.circle ? '円（半径 1 つ・角度なし）' : '楕円'} 位置 ${o.cb} bit、半径 ${o.rb} bit${o.circle ? '' : `、角度 ${o.ab} bit`}、色 ${o.col.join(':')}、濃さ ${o.aBits} bit${o.soft ? '、輪郭ぼかし ' + o.soft.map(([q, w]) => `q≤${q}→${w}`).join(' ') : ''}`;
  }), '');
  const out = path.join(__dirname, 'results', 'shapeeval.md');
  fs.writeFileSync(out, lines.join('\n'));
  console.log(lines.join('\n'));
} else {
  console.log('usage: node shape-eval.js encode|eval|summary <image> <variant>');
}
