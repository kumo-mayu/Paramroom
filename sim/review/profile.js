'use strict';
// Profile one evaluation task: time split into encode / decoder.apply / decoder.render / metrics / other.
// usage: node review/profile.js codec B cfgLabel image [grid]
const path = require('path');
const M = require('../lib/metrics');
const E = require('../lib/evaluate');

const [codecName, Bs, label, image = 'kodim23', grid = 'full'] = process.argv.slice(2);
const B = Number(Bs);
const codec = E.loadCodec(codecName);
const cfg = codec.configs(B).find(c => c.label === label);
const t = { encode: 0, apply: 0, render: 0, metrics: 0 };
const n = { apply: 0, render: 0, metrics: 0 };
const now = () => Number(process.hrtime.bigint()) / 1e6;

const origEncode = codec.encode, origDecoder = codec.decoder, origAll = M.all;
codec.encode = (...a) => { const s = now(); const r = origEncode.apply(codec, a); t.encode += now() - s; return r; };
codec.decoder = (...a) => {
  const d = origDecoder.apply(codec, a);
  const ap = d.apply.bind(d), re = d.render.bind(d);
  d.apply = bits => { const s = now(); ap(bits); t.apply += now() - s; n.apply++; };
  d.render = () => { const s = now(); const r = re(); t.render += now() - s; n.render++; return r; };
  return d;
};
M.all = (ref, img) => { const s = now(); const r = origAll(ref, img); t.metrics += now() - s; n.metrics++; return r; };

const s0 = now();
const res = E.evaluateTask({ codec: codecName, cfg, B, image, grid, imageDir: 'ref' });
const total = now() - s0;
const other = total - t.encode - t.apply - t.render - t.metrics;
const pct = x => (100 * x / total).toFixed(1).padStart(5) + '%';
console.log(`${codecName} ${label} B=${B} grid=${grid}: total ${(total / 1000).toFixed(1)} s, rows ${res.rows.length}`);
console.log(`  encode  ${pct(t.encode)}  ${(t.encode / 1000).toFixed(2)} s`);
console.log(`  apply   ${pct(t.apply)}  ${n.apply} calls, ${(t.apply / Math.max(1, n.apply)).toFixed(3)} ms each`);
console.log(`  render  ${pct(t.render)}  ${n.render} calls, ${(t.render / Math.max(1, n.render)).toFixed(1)} ms each`);
console.log(`  metrics ${pct(t.metrics)}  ${n.metrics} calls, ${(t.metrics / Math.max(1, n.metrics)).toFixed(1)} ms each`);
console.log(`  other   ${pct(other)}  (schedule/arrivals/hashing/rows)`);
