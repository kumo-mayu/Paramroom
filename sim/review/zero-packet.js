'use strict';
// Effect of a spurious all-zero packet (e.g. animator first-entry quirk) applied to a fully decoded state,
// and whether one clean re-send of the whole carousel repairs it.
const I = require('../lib/image'), M = require('../lib/metrics'), E = require('../lib/evaluate');
const ref = I.loadPNG('images/ref/kodim23.png');
const cases = [['wavl', 256, 'L48-12'], ['pw', 256, 'n100-t7-c565a2-r128-L48-12'], ['prim', 256, 't7-c565a2-r128-n1000'], ['dctv', 256, 'r128-s2'], ['pal', 256, 'g64-k3'], ['raw', 256, 'g16-b2-rows2'], ['wavl', 32, 'L192-64-20'], ['prim', 32, 'e6.5.4-c332a2-r256-n200']];
for (const [c, B, label] of cases) {
  const codec = E.loadCodec(c), cfg = codec.configs(B).find(x => x.label === label), P = B - 2;
  const units = codec.encode(ref, cfg, P).units.map(u => E.padBits(u, P));
  const d = codec.decoder(cfg, P);
  units.forEach(u => d.apply(u));
  const clean = M.all(ref, d.render()).msssimc;
  d.apply(new Array(P).fill(0));
  const hit = M.all(ref, d.render()).msssimc;
  units.forEach(u => d.apply(u));
  const healed = M.all(ref, d.render()).msssimc;
  console.log(`${c} ${B} ${label}: clean ${clean.toFixed(4)} after-zero ${hit.toFixed(4)} after-resend ${healed.toFixed(4)}`);
}
