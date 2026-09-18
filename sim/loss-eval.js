'use strict';
// Does the re-fitted encoding hold up when packets are lost? (docs/research/08 §21)
// Re-fitting makes each primitive depend on the others being present, so a lossy channel could hurt it more than it
// hurts the plain greedy encoding. The congested channel here is a pessimistic guess, not a measurement.
//   node loss-eval.js <image> <variant>   -> results/losseval.jsonl
//   node loss-eval.js summary
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const M = require('./lib/metrics');
const T = require('./lib/transport');
const FF = require('./lib/schedules-ff');
const primx = require('./codecs/primx');
const SHAPE = require('./lib/shape-variants');

const P = 254, R = 512;
const TIMES = [10, 30, 60, 120, 240];
const SEEDS = 3;
// name, sampler, hold (s): the sender can slow down (the app allows up to 3 s), which trades cycle time for loss
const CHANNELS = [
  ['実測 100ms', 'meas60', 0.1],
  ['混雑 100ms', 'congested', 0.1],
  ['混雑 250ms', 'congested', 0.25],
];
const out = path.join(__dirname, 'results', 'losseval.jsonl');
const [image, variant] = process.argv.slice(2);

if (image === 'summary') {
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  const vars = [...new Set(rows.map(r => r.variant))];
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const lines = ['# 損失のあるチャネルでの比較', '',
    `画像 ${[...new Set(rows.map(r => r.image))].length} 枚、${SEEDS} シード。`,
    '「混雑」は実測ではなく、遠隔の更新間隔が 120〜300 ms に伸びると仮定した悲観的なモデル。',
    '送信間隔 (hold) を伸ばすと 1 周は遅くなるが取りこぼしは減る（アプリで変えられる）。', ''];
  for (const [cname] of CHANNELS) {
    lines.push(`## ${cname}`, '', '| 表現 | ' + TIMES.map(t => `${t} 秒`).join(' | ') + ' |', '|---|' + TIMES.map(() => '---:').join('|') + '|');
    for (const v of vars) {
      const cells = TIMES.map(t => { const g = rows.filter(r => r.variant === v && r.channel === cname && r.t === t); return g.length ? mean(g.map(r => r.q)).toFixed(4) : '-'; });
      if (cells.some(c => c !== '-')) lines.push(`| ${v} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  const p = path.join(__dirname, 'results', 'losseval.md');
  fs.writeFileSync(p, lines.join('\n'));
  console.log(lines.join('\n'));
  return;
}

const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', 'shape', `${image}-${variant}.json`), 'utf8'));
const cfg = SHAPE.cfgFor(variant, R, P);
const units = c.units.map(s => [...s].map(Number));
const N = units.length;
const ref = I.loadPNG(path.join(__dirname, 'images', 'ref' + R, image + '.png'));
const grey = I.create(R, R, 3, 128);
const rows = [];
for (const [cname, sampler, H] of CHANNELS) {
  const acc = TIMES.map(() => 0);
  for (let seed = 1; seed <= SEEDS; seed++) {
    const sqrt = () => T.makeSchedule(N, { type: 'sqrt', alpha: 0 }, 1, c.gains);
    const schedule = FF.firstPassWith(N, 8, sqrt(), sqrt());
    const arr = T.arrivals({ schedule, H, channel: { sampler, torn: 0 }, join: 0, tMax: TIMES[TIMES.length - 1], seed: seed * 7919 + 13, packetBytes: 32 });
    const dec = primx.decoder(cfg, P);
    let ai = 0, got = 0;
    TIMES.forEach((t, k) => {
      while (ai < arr.length && arr[ai].time <= t) { dec.apply(units[arr[ai].unit]); got++; ai++; }
      acc[k] += M.all(ref, got ? dec.render() : grey).msssimc / SEEDS;
    });
  }
  TIMES.forEach((t, k) => rows.push({ image, variant, channel: cname, t, q: +acc[k].toFixed(4) }));
}
fs.appendFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`${image} ${variant}: loss eval done`);
