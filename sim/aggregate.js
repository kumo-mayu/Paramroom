'use strict';
// Aggregation (v2).
//  select mode: node aggregate.js select results/select.jsonl --top 2 --out results/selected.json
//  report mode: node aggregate.js report results/full.jsonl [--metric msssimc] [--crc 0] [--ch bm14] [--policy carousel]
//               [--join 0] [--cap 90] [--cat photo|illust|screenshot] [--markdown]
// AUC = trapezoid of the metric over log(t) for t in [1, 60] s, normalised to [0, 1] scale of the metric.
// Rows are averaged over seeds, then images (every combo must cover the same image set).
const fs = require('fs');

const [mode, file, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const n = rest[i + 1];
    if (n === undefined || n.startsWith('--')) args[rest[i].slice(2)] = true; else { args[rest[i].slice(2)] = n; i++; }
  }
}
const metric = args.metric || 'msssimc';
const TIMES = [1, 2, 5, 10, 20, 40, 60];

function category(image) {
  return image.startsWith('kodim') ? 'photo' : image.startsWith('illust') ? 'illust' : 'screenshot';
}

function auc(vals) {
  let s = 0;
  for (let i = 1; i < TIMES.length; i++) s += (vals[i] + vals[i - 1]) / 2 * Math.log(TIMES[i] / TIMES[i - 1]);
  return s / Math.log(TIMES[TIMES.length - 1] / TIMES[0]);
}

function load(filter) {
  const text = fs.readFileSync(file, 'utf8');
  // key -> image -> t -> {sum, n}
  const acc = new Map();
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (!line) continue;
    const r = JSON.parse(line);
    if (filter && !filter(r)) continue;
    const k = [r.codec, r.B, r.cfg, r.crc, r.cap, r.ch, r.policy, r.join].join('|');
    let byImg = acc.get(k);
    if (!byImg) acc.set(k, (byImg = new Map()));
    let byT = byImg.get(r.image);
    if (!byT) byImg.set(r.image, (byT = new Map()));
    let a = byT.get(r.t);
    if (!a) byT.set(r.t, (a = { psnr: 0, ssim: 0, msssim: 0, ssimc: 0, msssimc: 0, n: 0 }));
    for (const m of ['psnr', 'ssim', 'msssim', 'ssimc', 'msssimc']) a[m] += r[m];
    a.n++;
  }
  return acc;
}

// mean over images of per-image seed-means; returns {vals:[..TIMES], images:n, perImageAuc: Map}
function summarize(byImg, m, imageFilter) {
  const vals = TIMES.map(() => 0);
  let n = 0;
  const perImage = new Map();
  for (const [img, byT] of byImg) {
    if (imageFilter && !imageFilter(img)) continue;
    const v = TIMES.map(t => { const a = byT.get(t); return a ? a[m] / a.n : NaN; });
    if (v.some(Number.isNaN)) continue;
    v.forEach((x, i) => (vals[i] += x));
    perImage.set(img, auc(v));
    n++;
  }
  return { vals: vals.map(x => x / n), images: n, perImage };
}

const fmt = v => (metric === 'psnr' ? v.toFixed(1) : v.toFixed(3));

if (mode === 'select') {
  const acc = load();
  const combos = [];
  for (const [k, byImg] of acc) {
    const [codec, B, cfg] = k.split('|');
    const s = summarize(byImg, metric);
    combos.push({ codec, B: +B, cfg, ...s, auc: auc(s.vals) });
  }
  const maxImages = Math.max(...combos.map(c => c.images));
  const top = Number(args.top || 2);
  const selected = [];
  for (const B of [...new Set(combos.map(c => c.B))].sort((a, b) => b - a)) {
    console.log(`\n=== B=${B} (metric ${metric}, AUC over log t, training images) ===`);
    console.log('codec  cfg                        imgs |' + TIMES.map(t => `t=${t}`.padStart(7)).join('') + ' |   AUC');
    for (const codec of [...new Set(combos.map(c => c.codec))]) {
      const list = combos.filter(c => c.B === B && c.codec === codec).sort((a, b) => b.auc - a.auc);
      list.forEach((c, i) => {
        const incomplete = c.images < maxImages ? ' (INCOMPLETE)' : '';
        console.log(`${(i < top ? '*' : ' ') + codec.padEnd(6)} ${c.cfg.padEnd(26)} ${String(c.images).padStart(4)} |` + c.vals.map(v => fmt(v).padStart(7)).join('') + ` | ${fmt(c.auc)}${incomplete}`);
        if (i < top && !incomplete) selected.push({ codec, B, cfg: c.cfg, auc: +c.auc.toFixed(4) });
      });
    }
  }
  if (args.out) { fs.writeFileSync(args.out, JSON.stringify(selected, null, 1)); console.log('\nwrote', args.out, selected.length); }
} else if (mode === 'report') {
  const want = (name, v) => args[name] === undefined || String(v) === String(args[name]);
  const acc = load(r => want('crc', r.crc) && want('ch', r.ch) && want('policy', r.policy) && want('join', r.join) && want('cap', r.cap) && want('B', r.B));
  const catFilter = args.cat ? img => category(img) === args.cat : null;
  const groups = new Map();
  for (const [k, byImg] of acc) {
    const [codec, B, cfg, crc, cap, ch, policy, join] = k.split('|');
    const s = summarize(byImg, metric, catFilter);
    if (!s.images) continue;
    const g = [B, crc, cap, ch, policy, join].join('|');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ codec, cfg, ...s, auc: auc(s.vals) });
  }
  const md = !!args.markdown;
  for (const [g, list] of [...groups].sort((a, b) => Number(b[0].split('|')[0]) - Number(a[0].split('|')[0]))) {
    const [B, crc, cap, ch, policy, join] = g.split('|');
    const maxImages = Math.max(...list.map(c => c.images));
    list.sort((a, b) => b.auc - a.auc);
    const title = `B=${B} crc=${crc} ch=${ch} policy=${policy} join=${join} cap=${cap}${args.cat ? ' cat=' + args.cat : ''} metric=${metric} images=${maxImages}`;
    if (md) {
      console.log(`\n**${title}**\n`);
      console.log('| codec | cfg | ' + TIMES.map(t => `${t}s`).join(' | ') + ' | AUC |');
      console.log('|---|---|' + TIMES.map(() => '---:').join('|') + '|---:|');
      for (const c of list) console.log(`| ${c.codec} | ${c.cfg} | ` + c.vals.map(fmt).join(' | ') + ` | **${fmt(c.auc)}**${c.images < maxImages ? ' (incomplete)' : ''} |`);
    } else {
      console.log(`\n=== ${title} ===`);
      for (const c of list) console.log(`${c.codec.padEnd(6)} ${c.cfg.padEnd(26)} |` + c.vals.map(v => fmt(v).padStart(7)).join('') + ` | AUC ${fmt(c.auc)}${c.images < maxImages ? ' (incomplete)' : ''}`);
    }
  }
} else {
  console.error('usage: node aggregate.js select|report <file> ...');
}
