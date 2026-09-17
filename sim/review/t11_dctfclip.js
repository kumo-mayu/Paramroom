const path = require('path'); const I = require('../lib/image'); const C = require('../codecs/dct-common');
const D = require('../codecs/dctf');
const cfg = D.configs(256).find(c => c.label === 'r256-s2');
D.decoder(cfg, 254);
// re-derive widths the same way (dctf.js:13-28) by calling encode on a probe and reading packing via require cache is private; recompute:
const { trainingImages } = require('../codecs/training');
const lay = C.makeLayout(cfg);
const samples = lay.groups.map(() => []);
for (const img of trainingImages()) { const q = C.quantizeImage(img, lay); lay.groups.forEach((g, gi) => { for (let b = 0; b < g.nb; b++) samples[gi].push(Math.abs(q[g.start + b])); }); }
const w = samples.map(s => { s.sort((a, b) => a - b); const m = s[Math.floor(s.length * 0.999)]; return m === 0 ? 0 : Math.ceil(Math.log2(m + 1)) + 1; });
for (const im of ['kodim23', 'illust_tux']) {
  const ref = I.loadPNG(path.join(__dirname, '..', 'images', 'ref', im + '.png')); const q = C.quantizeImage(ref, lay);
  const rep = [];
  lay.groups.forEach((g, gi) => { const lim = w[gi] ? (1 << (w[gi] - 1)) - 1 : 0; let n = 0, mx = 0; for (let b = 0; b < g.nb; b++) { const v = q[g.start + b]; if (v > lim || v < -lim - 1) { n++; mx = Math.max(mx, Math.abs(v)); } } if (n) rep.push(`ch${g.ch}k${g.k}(w=${w[gi]}):${n}clip,max${mx}`); });
  console.log(im, rep.slice(0, 12).join(' '), `... groups clipped: ${rep.length}`);
}
