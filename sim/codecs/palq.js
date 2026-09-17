'use strict';
// PALQ: colour reduction by palette + progressive quadtree index map (for flat-colour art, UI, text).
//
// Encoder: k-means palette of 2^kb colours (RGB565) on the r x r image; per-pixel nearest index.
// Index pyramid: level 0 = 1 node ... level log2(r) = r x r pixels; a node's value = most frequent index
// in its region. A node is EXPLICIT iff its value differs from its parent's value (root always explicit).
// Stream position per node (levels coarse->fine, raster within level): q = explicit ? value+1 : 0,
// coded with packet-coder (small levels dense, others sparse zero-run + level).
// Render: each pixel takes the value of its deepest EXPLICIT ancestor-or-self (order independent: missing
// packets just make regions inherit a coarser ancestor's colour), then palette lookup, bilinear to 256.
// Packet = [type (1 bit)] + body:  type 0 = palette: [first entry (kb bits)] [RGB565 entries...]
//                                  type 1 = quadtree run (packet-coder format)
// Shader side: palette texels + one RG8 texel per node (~r^2 * 4/3); per pixel <= log2(r)+1 lookups.
const I = require('../lib/image');
const PC = require('./packet-coder');
const { BitWriter, BitReader } = require('../lib/bits');
const { trainingImages } = require('./training');

function to565(c) {
  const r = Math.round(c[0] / 255 * 31), g = Math.round(c[1] / 255 * 63), b = Math.round(c[2] / 255 * 31);
  return (r << 11) | (g << 5) | b;
}
function from565(v) { return [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31]; }

function kmeans(px, k, iters = 25) {
  const n = px.length / 3, cent = [];
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  cent.push([px[0], px[1], px[2]]);
  const dist = new Float64Array(n).fill(Infinity);
  while (cent.length < k) {
    const c = cent[cent.length - 1];
    let tot = 0;
    for (let i = 0; i < n; i++) {
      const d = (px[i * 3] - c[0]) ** 2 + (px[i * 3 + 1] - c[1]) ** 2 + (px[i * 3 + 2] - c[2]) ** 2;
      if (d < dist[i]) dist[i] = d;
      tot += dist[i];
    }
    if (tot === 0) { cent.push(c.slice()); continue; }
    let t = rnd() * tot, idx = 0;
    for (; idx < n - 1; idx++) { t -= dist[idx]; if (t <= 0) break; }
    cent.push([px[idx * 3], px[idx * 3 + 1], px[idx * 3 + 2]]);
  }
  for (let it = 0; it < iters; it++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = (px[i * 3] - cent[j][0]) ** 2 + (px[i * 3 + 1] - cent[j][1]) ** 2 + (px[i * 3 + 2] - cent[j][2]) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      const sm = sum[best];
      sm[0] += px[i * 3]; sm[1] += px[i * 3 + 1]; sm[2] += px[i * 3 + 2]; sm[3]++;
    }
    for (let j = 0; j < k; j++) if (sum[j][3]) cent[j] = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
  }
  return cent;
}

function makeLayout(cfg) {
  const levels = Math.log2(cfg.r) + 1;
  const groups = [];
  let pos = 0;
  for (let l = 0; l < levels; l++) {
    const side = 1 << l;
    groups.push({ level: l, side, start: pos, nb: side * side });
    pos += side * side;
  }
  const posGroup = new Int32Array(pos);
  groups.forEach((g, gi) => posGroup.fill(gi, g.start, g.start + g.nb));
  const denseEnd = groups.filter(g => g.nb <= 64).reduce((m, g) => Math.max(m, g.start + g.nb), 0);
  return { groups, total: pos, posGroup, denseEnd };
}

// returns { q, pal565, gains }
function analyse(ref, cfg, layout, wantGains) {
  const r = cfg.r, K = 1 << cfg.kb;
  const small = I.resize(ref, r, r);
  const pal565 = kmeans(small.data, K).map(to565);
  const pal = pal565.map(from565);
  const idx = new Int32Array(r * r);
  for (let i = 0; i < r * r; i++) {
    let best = 0, bd = Infinity;
    for (let j = 0; j < K; j++) {
      const c = pal[j];
      const d = (small.data[i * 3] - c[0]) ** 2 + (small.data[i * 3 + 1] - c[1]) ** 2 + (small.data[i * 3 + 2] - c[2]) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    idx[i] = best;
  }
  const L = layout.groups.length;
  const value = layout.groups.map(g => new Int32Array(g.nb));
  // finest level = pixels; coarser: mode of region via histogram
  value[L - 1].set(idx);
  for (let l = L - 2; l >= 0; l--) {
    const side = 1 << l, span = r / side;
    for (let y = 0; y < side; y++)
      for (let x = 0; x < side; x++) {
        const hist = new Int32Array(K);
        for (let yy = y * span; yy < (y + 1) * span; yy++) for (let xx = x * span; xx < (x + 1) * span; xx++) hist[idx[yy * r + xx]]++;
        let best = 0;
        for (let j = 1; j < K; j++) if (hist[j] > hist[best]) best = j;
        value[l][y * side + x] = best;
      }
  }
  const q = new Int32Array(layout.total);
  const gains = wantGains ? new Float64Array(layout.total) : null;
  const scale = (256 / r) ** 2;
  for (let l = 0; l < L; l++) {
    const g = layout.groups[l], side = g.side, span = r / side;
    for (let y = 0; y < side; y++)
      for (let x = 0; x < side; x++) {
        const v = value[l][y * side + x];
        const parent = l === 0 ? -1 : value[l - 1][(y >> 1) * (side >> 1) + (x >> 1)];
        if (v === parent) continue;
        q[g.start + y * side + x] = v + 1;
        if (gains) {
          // SSE change over the node region when its colour changes from parent's to its own
          const cv = pal[v], cp = parent >= 0 ? pal[parent] : [128, 128, 128];
          let gsum = 0;
          for (let yy = y * span; yy < (y + 1) * span; yy++)
            for (let xx = x * span; xx < (x + 1) * span; xx++) {
              const o = (yy * r + xx) * 3;
              for (let k = 0; k < 3; k++) gsum += (small.data[o + k] - cp[k]) ** 2 - (small.data[o + k] - cv[k]) ** 2;
            }
          gains[g.start + y * side + x] = gsum * scale;
        }
      }
  }
  return { q, pal565, gains };
}

const cache = new Map();
function setup(cfg) {
  const key = `${cfg.r}/${cfg.kb}`;
  if (!cache.has(key)) {
    const layout = makeLayout(cfg);
    const tab = PC.train(layout, trainingImages().map(img => analyse(img, cfg, layout).q));
    cache.set(key, { layout, tab });
  }
  return cache.get(key);
}

module.exports = {
  name: 'palq',
  configs(B) {
    const set = B >= 128 ? [[4, 128], [4, 256], [5, 128], [5, 256]] : B >= 64 ? [[3, 64], [4, 64], [4, 128]] : [[2, 64], [3, 64], [3, 128]];
    const idxMax = B >= 128 ? 10 : B >= 64 ? 8 : 6;
    return set.map(([kb, r]) => ({ label: `k${kb}-r${r}`, kb, r, idxMax, adapt: false }));
  },
  encode(ref, cfg, P) {
    const { layout, tab } = setup(cfg);
    const { q, pal565, gains } = analyse(ref, cfg, layout, true);
    const units = [];
    // palette units
    const perUnit = Math.floor((P - 1 - cfg.kb) / 16);
    if (perUnit < 1) throw new Error('palq: payload too small for a palette entry');
    for (let e = 0; e < pal565.length; e += perUnit) {
      const w = new BitWriter();
      w.write(0, 1); w.write(e, cfg.kb);
      for (let j = e; j < Math.min(pal565.length, e + perUnit); j++) w.write(pal565[j], 16);
      units.push({ bits: w.bits, gain: Infinity, ord: units.length });
    }
    const { runs, spans } = PC.encodeStream(layout, tab, q, P - 1, cfg);
    const pre = new Float64Array(gains.length + 1);
    for (let i = 0; i < gains.length; i++) pre[i + 1] = pre[i] + gains[i];
    runs.forEach((bits, i) => units.push({ bits: [1].concat(bits), gain: pre[spans[i][1]] - pre[spans[i][0]], ord: 1e6 + i }));
    units.sort((a, b) => b.gain - a.gain || a.ord - b.ord);
    return { units: units.map(u => u.bits), baseCount: Math.ceil(pal565.length / perUnit) };
  },
  decoder(cfg, P) {
    const { layout, tab } = setup(cfg);
    const K = 1 << cfg.kb, r = cfg.r;
    const pal = new Array(K).fill(null);
    const q = new Int32Array(layout.total);
    const perUnit = Math.floor((P - 1 - cfg.kb) / 16);
    return {
      stateInfo: `palette ${K} + node values ${layout.total}`,
      apply(bits) {
        if (bits[0] === 0) {
          const rd = new BitReader(bits);
          rd.read(1);
          const e = rd.read(cfg.kb);
          for (let j = e; j < Math.min(K, e + perUnit); j++) pal[j] = from565(rd.read(16));
        } else PC.apply(layout, tab, q, bits.slice(1), cfg);
      },
      render() {
        const img = I.create(r, r, 3, 128);
        const L = layout.groups.length;
        for (let y = 0; y < r; y++)
          for (let x = 0; x < r; x++) {
            for (let l = L - 1; l >= 0; l--) {
              const g = layout.groups[l], sh = L - 1 - l;
              const v = q[g.start + (y >> sh) * g.side + (x >> sh)];
              if (v > 0) {
                const c = pal[v - 1];
                if (c) { const o = (y * r + x) * 3; img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; }
                break;
              }
            }
          }
        return I.quantize8(I.resize(img, 256, 256));
      },
    };
  },
};
