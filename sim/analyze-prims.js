'use strict';
// Where do the 58 bits of a primitive actually go? Reads encoded units (cache/primscale/<image>-r512-n4000.json) and
// measures, per field: the allocated bits, the empirical entropy with one table for all images (what a static code could
// reach), the entropy with a per-image table, and the entropy of the difference to the first primitive of the same packet
// (the only prediction that keeps packets self-contained). Also: how the error reduction (gain) is spread over the
// primitives, how many primitives are nearly circular (their angle bits carry nothing), and how well a primitive's colour
// is predicted by the canvas under it (a predictor the decoder could compute, but only if every earlier packet arrived).
// usage: node analyze-prims.js [out=results/prim-stats.md]
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');
const prim = require('./codecs/prim');

const out = process.argv[2] || path.join(__dirname, 'results', 'prim-stats.md');
const cacheDir = path.join(__dirname, 'cache', 'primscale');
const R = 512, N = 4000;
const cfg = { ...prim.cfgOf({ shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, R, maxPrims: N }), out: R };
const L = prim.layout(cfg, 254);
const FIELDS = [['cx', 9], ['cy', 9], ['rx', 8], ['ry', 8], ['th', 6], ['r', 5], ['g', 6], ['b', 5], ['a', 2]];

const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('-r512-n4000.json'));
const perImage = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8'));
  const image = f.replace('-r512-n4000.json', '');
  const units = j.units.map(s => [...s].map(Number));
  const gains = j.gains.map(g => (g === null ? Infinity : g));
  // primitive j -> (unit id, bit offset) exactly as the decoder reads it
  const prims = [];
  for (let p = 0; p < L.maxPrims; p++) {
    let uid, off;
    if (p < L.k0) { uid = 0; off = L.u + 16 + p * L.primBits; }
    else { uid = 1 + Math.floor((p - L.k0) / L.k); off = L.u + ((p - L.k0) % L.k) * L.primBits; }
    if (uid >= units.length) break;
    const bits = units[uid];
    let o = off;
    const v = {};
    for (const [name, w] of FIELDS) { let x = 0; for (let i = 0; i < w; i++) x = (x << 1) | bits[o + i]; o += w; v[name] = x; }
    v.unit = uid; v.slot = uid === 0 ? p : (p - L.k0) % L.k; v.index = p;
    prims.push(v);
  }
  perImage.push({ image, prims, gains, units });
}

const entropy = counts => {
  const total = counts.reduce((a, b) => a + b, 0);
  let h = 0;
  for (const c of counts) if (c > 0) h -= (c / total) * Math.log2(c / total);
  return h;
};
const hist = (values, size) => { const c = new Array(size).fill(0); for (const v of values) c[v]++; return c; };

// ---- per field: allocated vs empirical entropy
const all = perImage.flatMap(p => p.prims);
const rows = [];
for (const [name, w] of FIELDS) {
  const pooled = entropy(hist(all.map(p => p[name]), 1 << w));
  const perImg = perImage.reduce((a, p) => a + entropy(hist(p.prims.map(x => x[name]), 1 << w)) * p.prims.length, 0) / all.length;
  // difference to the first primitive of the same packet (wraps into the field's range)
  const deltas = [];
  for (const { prims } of perImage) {
    const bySlot = new Map();
    for (const p of prims) {
      if (p.slot === 0 || p.unit === 0) { bySlot.set(p.unit, p); continue; }
      const first = bySlot.get(p.unit);
      if (first) deltas.push(((p[name] - first[name]) % (1 << w) + (1 << w)) % (1 << w));
    }
  }
  const hDelta = entropy(hist(deltas, 1 << w));
  rows.push({ name, w, pooled, perImg, hDelta });
}

// ---- gain distribution (per primitive, from the per-unit gains: unit gain / k)
const gainRows = [];
for (const { image, gains } of perImage) {
  const finite = gains.slice(1).filter(Number.isFinite);
  const total = finite.reduce((a, b) => a + b, 0);
  const cum = [];
  let acc = 0;
  for (const g of finite) { acc += g; cum.push(acc / total); }
  const at = f => cum.findIndex(c => c >= f) + 1; // units needed for f of the total error reduction
  gainRows.push({ image, units: finite.length, u50: at(0.5), u80: at(0.8), u95: at(0.95), last10: 1 - (cum[Math.floor(cum.length * 0.9) - 1] ?? 1) });
}

// ---- how many primitives are nearly circular (angle carries nothing) and how small they are
const rN = 1 << 8;
const radius = q => Math.max(0.5, R / 2 * ((q + 1) / rN) ** 2);
let circular = 0, tiny = 0;
const radii = [];
for (const p of all) {
  const a = radius(p.rx), b = radius(p.ry);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  if (hi / lo < 1.1) circular++;
  if (hi < 4) tiny++;
  radii.push(hi);
}
radii.sort((a, b) => a - b);

// ---- colour predicted by the canvas under the primitive (needs every earlier primitive: not packet-safe, measured to
// see how much a "perfect predictor" could save)
const colourRows = [];
for (const { image, prims } of perImage.slice(0, 4)) {
  const ref = I.loadPNG(path.join(__dirname, 'images', 'ref512', image + '.png'));
  const dec = prim.decoder(cfg, 254);
  const G = { };  // render incrementally: draw prefix, read mean colour under the next primitive
  const canvas = new Float64Array(R * R * 3);
  const j = JSON.parse(fs.readFileSync(path.join(cacheDir, image + '-r512-n4000.json'), 'utf8'));
  const bg = (() => { const b = []; let x = 0; const bits = [...j.units[0]].map(Number); for (let i = 0; i < 16; i++) x = (x << 1) | bits[L.u + i]; return [((x >> 11) & 31) * 255 / 31, ((x >> 5) & 63) * 255 / 63, (x & 31) * 255 / 31]; })();
  for (let i = 0; i < R * R; i++) { canvas[i * 3] = bg[0]; canvas[i * 3 + 1] = bg[1]; canvas[i * 3 + 2] = bg[2]; }
  const cmax = 511, aN = 64;
  const deltaR = [], deltaG = [], deltaB = [];
  for (const p of prims) {
    const cx = p.cx / cmax * R, cy = p.cy / cmax * R, rx = radius(p.rx), ry = radius(p.ry), th = p.th / aN * Math.PI;
    const c = Math.cos(th), s = Math.sin(th), irx = 1 / (rx * rx), iry = 1 / (ry * ry);
    const ex = Math.sqrt(rx * rx * c * c + ry * ry * s * s), ey = Math.sqrt(rx * rx * s * s + ry * ry * c * c);
    const bx0 = Math.max(0, Math.floor(cx - ex - 0.5)), bx1 = Math.min(R - 1, Math.ceil(cx + ex));
    const by0 = Math.max(0, Math.floor(cy - ey - 0.5)), by1 = Math.min(R - 1, Math.ceil(cy + ey));
    let n = 0, sr = 0, sg = 0, sb = 0;
    const idx = [];
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy, u = dx * c + dy * s, v = dy * c - dx * s;
      if (u * u * irx + v * v * iry > 1) continue;
      const o = (y * R + x) * 3;
      idx.push(o); n++; sr += canvas[o]; sg += canvas[o + 1]; sb += canvas[o + 2];
    }
    if (n === 0) continue;
    // predictor: the canvas colour under the primitive, quantized in the same grid as the field
    const q = (mean, levels) => Math.max(0, Math.min(levels, Math.round(mean / 255 * levels)));
    deltaR.push(((p.r - q(sr / n, 31)) % 32 + 32) % 32);
    deltaG.push(((p.g - q(sg / n, 63)) % 64 + 64) % 64);
    deltaB.push(((p.b - q(sb / n, 31)) % 32 + 32) % 32);
    const alpha = (p.a + 1) / 4, ia = 1 - alpha;
    const cr = p.r * 255 / 31 * alpha, cg = p.g * 255 / 63 * alpha, cb = p.b * 255 / 31 * alpha;
    for (const o of idx) { canvas[o] = canvas[o] * ia + cr; canvas[o + 1] = canvas[o + 1] * ia + cg; canvas[o + 2] = canvas[o + 2] * ia + cb; }
  }
  colourRows.push({ image, hr: entropy(hist(deltaR, 32)), hg: entropy(hist(deltaG, 64)), hb: entropy(hist(deltaB, 32)) });
}

// ---- report
const f3 = x => x.toFixed(3);
const lines = [
  `# 現在の primitive 表現のビットの使われ方（512 キャンバス・図形 4000 個・${files.length} 枚）`, '',
  '`sim/analyze-prims.js`。既に符号化してある `sim/cache/primscale/*-r512-n4000.json` を読み、フィールドごとに',
  '割り当てビット・実際の情報量（エントロピー）を測った。エントロピーは符号化の下限なので、「割り当て − エントロピー」が',
  '固定長で捨てている分にあたる。', '',
  '## フィールドごと', '',
  '| フィールド | 割り当て | 全画像で 1 つの表を使う場合 | 画像ごとの表 | 同じパケットの 1 個目との差分 |',
  '|---|---:|---:|---:|---:|',
  ...rows.map(r => `| ${r.name} | ${r.w} bit | ${f3(r.pooled)} | ${f3(r.perImg)} | ${f3(r.hDelta)} |`),
  `| **合計** | **${FIELDS.reduce((a, [, w]) => a + w, 0)} bit** | **${f3(rows.reduce((a, r) => a + r.pooled, 0))}** | **${f3(rows.reduce((a, r) => a + r.perImg, 0))}** | **${f3(rows.reduce((a, r) => a + r.hDelta, 0))}** |`,
  '',
  '## 形の偏り', '',
  `- ほぼ円（長短の半径比 1.1 未満）：${(circular / all.length * 100).toFixed(1)} %。角度の 6 bit はこの分ほぼ無駄。`,
  `- 長い方の半径が 4 px 未満の小さい図形：${(tiny / all.length * 100).toFixed(1)} %。`,
  `- 半径（長い方）の中央値 ${radii[Math.floor(radii.length / 2)].toFixed(1)} px、10 % 点 ${radii[Math.floor(radii.length * 0.1)].toFixed(1)} px、90 % 点 ${radii[Math.floor(radii.length * 0.9)].toFixed(1)} px。`,
  '',
  '## 誤差の減り方（ユニット単位、gains）', '',
  '| 画像 | ユニット | 誤差削減の 50 % に要するユニット | 80 % | 95 % | 後ろ 10 % のユニットが持つ割合 |',
  '|---|---:|---:|---:|---:|---:|',
  ...gainRows.map(g => `| ${g.image} | ${g.units} | ${g.u50} | ${g.u80} | ${g.u95} | ${(g.last10 * 100).toFixed(2)} % |`),
  '',
  '## 色を「下の絵」から予測できるか（パケット独立性を捨てた場合の上限）', '',
  '| 画像 | R の差分 | G | B | 合計（今は 16 bit） |',
  '|---|---:|---:|---:|---:|',
  ...colourRows.map(c => `| ${c.image} | ${f3(c.hr)} | ${f3(c.hg)} | ${f3(c.hb)} | ${f3(c.hr + c.hg + c.hb)} |`),
  '',
];
fs.writeFileSync(out, lines.join('\n'));
console.log(lines.join('\n'));
