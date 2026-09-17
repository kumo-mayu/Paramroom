'use strict';
// PAL: palette-indexed raster at low resolution, progressive lattice order (baseline).
//
// Static layout: units 0.. carry the palette (RGB565 per entry), then pixel indices in hierarchical
// lattice order (step 16, 8, 4, 2, 1). Packet = [unit id (u bits)] [fixed-width fields].
// Render: each grid cell shows its own colour if known, else its nearest received lattice ancestor;
// grid is bilinearly upscaled to 256.
const { BitWriter, BitReader } = require('../lib/bits');
const I = require('../lib/image');

function latticeOrder(r) {
  const order = [];
  const seen = new Uint8Array(r * r);
  for (let s = 16; s >= 1; s >>= 1)
    for (let y = 0; y < r; y += s)
      for (let x = 0; x < r; x += s)
        if (!seen[y * r + x]) { seen[y * r + x] = 1; order.push(y * r + x); }
  return order;
}

const packCache = new Map();
function packing(cfg, P) {
  const key = `${cfg.r}/${cfg.kb}/${P}`;
  if (packCache.has(key)) return packCache.get(key);
  const nPal = 1 << cfg.kb;
  const seq = [];
  for (let i = 0; i < nPal; i++) seq.push({ kind: 'pal', i, w: 16 });
  for (const p of latticeOrder(cfg.r)) seq.push({ kind: 'px', i: p, w: cfg.kb });
  for (let u = 1; u < 20; u++) {
    const cap = P - u, units = [];
    let cur = [], used = 0;
    for (const e of seq) {
      if (used + e.w > cap) { units.push(cur); cur = []; used = 0; }
      cur.push(e); used += e.w;
    }
    if (cur.length) units.push(cur);
    if (units.length <= (1 << u)) { const res = { u, units }; packCache.set(key, res); return res; }
  }
  throw new Error('packing failed');
}

function to565(c) {
  const r = Math.round(c[0] / 255 * 31), g = Math.round(c[1] / 255 * 63), b = Math.round(c[2] / 255 * 31);
  return (r << 11) | (g << 5) | b;
}
function from565(v) {
  return [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31];
}

function kmeans(pixels, k, iters = 30) {
  // deterministic init: k-means++ with fixed pseudo-random sequence
  const n = pixels.length / 3;
  const cent = [];
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  cent.push([pixels[0], pixels[1], pixels[2]]);
  const dist = new Float64Array(n).fill(Infinity);
  while (cent.length < k) {
    const c = cent[cent.length - 1];
    let tot = 0;
    for (let i = 0; i < n; i++) {
      const d = (pixels[i * 3] - c[0]) ** 2 + (pixels[i * 3 + 1] - c[1]) ** 2 + (pixels[i * 3 + 2] - c[2]) ** 2;
      if (d < dist[i]) dist[i] = d;
      tot += dist[i];
    }
    let t = rnd() * tot, idx = 0;
    for (; idx < n - 1; idx++) { t -= dist[idx]; if (t <= 0) break; }
    cent.push([pixels[idx * 3], pixels[idx * 3 + 1], pixels[idx * 3 + 2]]);
  }
  const assign = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = (pixels[i * 3] - cent[j][0]) ** 2 + (pixels[i * 3 + 1] - cent[j][1]) ** 2 + (pixels[i * 3 + 2] - cent[j][2]) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      assign[i] = best;
      const sm = sum[best];
      sm[0] += pixels[i * 3]; sm[1] += pixels[i * 3 + 1]; sm[2] += pixels[i * 3 + 2]; sm[3]++;
    }
    for (let j = 0; j < k; j++) if (sum[j][3]) cent[j] = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
  }
  return cent;
}

module.exports = {
  name: 'pal',
  configs(B) {
    const out = [];
    for (const r of [32, 64, 128]) for (const kb of [3, 5]) out.push({ label: `g${r}-k${kb}`, r, kb });
    return out;
  },
  encode(ref, cfg, P) {
    const pk = packing(cfg, P);
    const small = I.resize(ref, cfg.r, cfg.r);
    const pal565 = kmeans(small.data, 1 << cfg.kb).map(to565);
    const palRGB = pal565.map(from565);
    const idx = new Int32Array(cfg.r * cfg.r);
    for (let i = 0; i < idx.length; i++) {
      let best = 0, bd = Infinity;
      palRGB.forEach((c, j) => {
        const d = (small.data[i * 3] - c[0]) ** 2 + (small.data[i * 3 + 1] - c[1]) ** 2 + (small.data[i * 3 + 2] - c[2]) ** 2;
        if (d < bd) { bd = d; best = j; }
      });
      idx[i] = best;
    }
    let baseCount = 0;
    const units = pk.units.map((entries, id) => {
      const w = new BitWriter();
      w.write(id, pk.u);
      for (const e of entries) w.write(e.kind === 'pal' ? pal565[e.i] : idx[e.i], e.w);
      if (entries.some(e => e.kind === 'pal')) baseCount = id + 1;
      return w.bits;
    });
    // base set also includes the step>=8 lattice pixels
    const coarse = Math.ceil(cfg.r / 8) ** 2 + (1 << cfg.kb) * 16 / cfg.kb;
    let acc = 0, id = 0;
    for (; id < pk.units.length && acc < coarse; id++) acc += pk.units[id].length;
    baseCount = Math.max(baseCount, id);
    return { units, baseCount };
  },
  decoder(cfg, P) {
    const pk = packing(cfg, P);
    const r = cfg.r;
    const pal = new Array(1 << cfg.kb).fill(null);
    const idx = new Int32Array(r * r).fill(-1);
    return {
      stateInfo: `index grid ${r}x${r} + palette`,
      apply(bits) {
        const rd = new BitReader(bits);
        const id = rd.read(pk.u);
        if (id >= pk.units.length) return;
        for (const e of pk.units[id]) {
          const v = rd.read(e.w);
          if (e.kind === 'pal') pal[e.i] = from565(v); else idx[e.i] = v;
        }
      },
      render() {
        const img = I.create(r, r, 3, 128);
        for (let y = 0; y < r; y++)
          for (let x = 0; x < r; x++) {
            for (let s = 1; s <= 16; s <<= 1) {
              const v = idx[(y - y % s) * r + (x - x % s)];
              if (v >= 0 && pal[v]) {
                const c = pal[v], o = (y * r + x) * 3;
                img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
                break;
              }
            }
          }
        return I.quantize8(I.resize(img, 256, 256));
      },
    };
  },
};
