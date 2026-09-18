'use strict';
// Is fast+sqrt/8 still the best send order after the re-fitting pass? (docs/research/08 §18)
// Re-fitting makes the primitives depend on each other more, so a partial set may behave differently; the send order
// was chosen before that existed. This re-runs the send-order candidates (sim/lib/schedules-ff.js) on a refined
// encoding, over the measured channel.
//   node order-eval.js <image> <variant>   -> results/ordereval.jsonl
//   node order-eval.js summary
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const M = require('./lib/metrics');
const T = require('./lib/transport');
const FF = require('./lib/schedules-ff');
const primx = require('./codecs/primx');
const SHAPE = require('./lib/shape-variants');

const P = 254, R = 512;
const TIMES = [5, 10, 20, 40, 80, 150];
const SEEDS = 3;
const out = path.join(__dirname, 'results', 'ordereval.jsonl');
const [image, variant] = process.argv.slice(2);

if (image === 'summary') {
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  const vars = [...new Set(rows.map(r => r.variant))];
  const orders = [...new Set(rows.map(r => r.order))];
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const lines = ['# 送信順の再検討（後付け最適化を入れた符号化で）', '',
    `画像 ${[...new Set(rows.map(r => r.image))].length} 枚、${SEEDS} シード、実測チャネル。`, ''];
  for (const v of vars) {
    for (const join of ['start', 'mid', 'late']) {
      lines.push(`## ${v} / ${join}`, '', '| 送り方 | ' + TIMES.map(t => `${t} 秒`).join(' | ') + ' |', '|---|' + TIMES.map(() => '---:').join('|') + '|');
      for (const o of orders) {
        const cells = TIMES.map(t => { const g = rows.filter(r => r.variant === v && r.join === join && r.order === o && r.t === t); return g.length ? mean(g.map(r => r.q)).toFixed(4) : '-'; });
        if (cells.some(c => c !== '-')) lines.push(`| ${o} | ${cells.join(' | ')} |`);
      }
      lines.push('');
    }
  }
  const p = path.join(__dirname, 'results', 'ordereval.md');
  fs.writeFileSync(p, lines.join('\n'));
  console.log(lines.join('\n'));
  return;
}

const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', 'shape', `${image}-${variant}.json`), 'utf8'));
const cfg = SHAPE.cfgFor(variant, R, P);
const units = c.units.map(s => [...s].map(Number));
const N = units.length;
const ref = I.loadPNG(path.join(__dirname, 'images', 'ref' + R, image + '.png'));
const ch = { sampler: 'meas60', H: 0.1, torn: 0 };
const grey = I.create(R, R, 3, 128);
const rows = [];
for (const [joinType, joinOf] of [['start', () => 0], ['mid', () => 30], ['late', s => 150 + 150 * T.mulberry32(s * 104729 + 7)()]]) {
  const acc = new Map();
  for (let seed = 1; seed <= SEEDS; seed++) {
    for (const [label, schedule] of FF.candidates(N, c.gains)) {
      const arr = T.arrivals({ schedule, H: ch.H, channel: ch, join: joinOf(seed), tMax: TIMES[TIMES.length - 1], seed: seed * 7919 + 13, packetBytes: 32 });
      const dec = primx.decoder(cfg, P);
      let ai = 0, got = 0;
      const a = acc.get(label) || TIMES.map(() => 0);
      TIMES.forEach((t, k) => {
        while (ai < arr.length && arr[ai].time <= t) { dec.apply(units[arr[ai].unit]); got++; ai++; }
        a[k] += M.all(ref, got ? dec.render() : grey).msssimc / SEEDS;
      });
      acc.set(label, a);
    }
  }
  for (const [label, a] of acc) TIMES.forEach((t, k) => rows.push({ image, variant, join: joinType, order: label, t, q: +a[k].toFixed(4) }));
}
fs.appendFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`${image} ${variant}: order eval done (${rows.length} rows)`);
