'use strict';
// run.js の結果から「閾値に届く最小ビット数」を出す（docs/research/12）。
//   node local/summary.js [local/results/rq.jsonl ...] > local/results/summary.md
// 画像ごとに (ビット数, 画質) の点を並べ、上側の包絡（それ以下のビット数での最良の画質）を作る。
// 閾値をまたぐ 2 点の間は log(ビット数) で線形に補間する。届かない画像は「未達」。
const fs = require('fs');
const path = require('path');
const C = require('./common');

const files = process.argv.slice(2).length ? process.argv.slice(2) : [path.join(__dirname, 'results', 'rq.jsonl')];
// 後のファイルに同じ方式があれば、前のファイルのその方式は捨てる（格子を広げて回し直したとき用）
let rows = [];
for (const f of files) {
  const r = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => !x.error);
  const names = new Set(r.map(x => x.codec));
  rows = rows.filter(x => !names.has(x.codec)).concat(r);
}

const METRICS = [
  ['msssimc', [0.95, 0.98, 0.99]],
  ['psnr', [30, 35, 40]],
  ['text_msssimc', [0.98, 0.99]],
];

function minBpp(points, key, T) {
  const pts = points.filter(p => p[key] != null).sort((a, b) => a.bpp - b.bpp);
  let best = -Infinity, prev = null;
  for (const p of pts) {
    if (p[key] <= best) continue; // 包絡に乗らない点
    if (p[key] >= T) {
      if (!prev) return p.bpp;
      const t = (T - prev[key]) / (p[key] - prev[key]);
      return Math.exp(Math.log(prev.bpp) + t * (Math.log(p.bpp) - Math.log(prev.bpp)));
    }
    best = p[key]; prev = p;
  }
  return null;
}

const by = new Map();
for (const r of rows) {
  const k = r.codec;
  if (!by.has(k)) by.set(k, { fam: r.fam, imgs: new Map() });
  const e = by.get(k);
  if (!e.imgs.has(r.image)) e.imgs.set(r.image, { kind: r.kind, pts: [] });
  e.imgs.get(r.image).pts.push(r);
}

const gmean = a => Math.exp(a.reduce((s, v) => s + Math.log(v), 0) / a.length);
const out = [];
const summary = {};
out.push(`# ローカル転送: 閾値に届く最小ビット数（bpp = 1 画素あたりのビット数）`);
out.push('');
out.push(`画像: ${C.SET.length} 枚（元の解像度、長辺 ≤ 960）。値は届いた画像での幾何平均、括弧は届いた枚数。`);
for (const [key, Ts] of METRICS) {
  out.push('');
  out.push(`## ${key}`);
  out.push('');
  const kinds = key === 'text_msssimc' ? ['screen'] : ['all', 'photo', 'illust', 'screen'];
  out.push('| 方式 | ' + Ts.flatMap(T => kinds.map(k => `${T} ${k}`)).join(' | ') + ' |');
  out.push('|---|' + Ts.flatMap(() => kinds.map(() => '---:')).join('|') + '|');
  const lines = [];
  for (const [codec, e] of by) {
    const cells = [];
    let sortKey = Infinity;
    for (const T of Ts)
      for (const kind of kinds) {
        const vals = [];
        let n = 0;
        for (const [img, v] of e.imgs) {
          if (kind !== 'all' && v.kind !== kind) continue;
          if (key === 'text_msssimc' && !C.TEXT[img]) continue;
          n++;
          const b = minBpp(v.pts, key, T);
          if (b != null) vals.push(b);
        }
        const g = vals.length ? gmean(vals) : null;
        cells.push(g == null ? `— (0/${n})` : `${g.toFixed(2)}${vals.length < n ? ` (${vals.length}/${n})` : ''}`);
        summary[`${codec}|${key}|${T}|${kind}`] = { bpp: g, reached: vals.length, n };
        if (kind === (key === 'text_msssimc' ? 'screen' : 'all') && T === Ts[1] && g != null && vals.length === n) sortKey = Math.min(sortKey, g);
      }
    lines.push({ sortKey, text: `| ${codec} | ${cells.join(' | ')} |` });
  }
  lines.sort((a, b) => a.sortKey - b.sortKey);
  out.push(...lines.map(l => l.text));
}

// 符号化時間（その方式の格子で、画像 1 枚あたりの中央値。JS・1 スレッド）
out.push('');
out.push('## 符号化時間（JS、1 スレッド、画像 1 枚・設定 1 つあたりの中央値 ms）');
out.push('');
out.push('| 方式 | ms |');
out.push('|---|---:|');
for (const [codec, e] of by) {
  const ms = [...e.imgs.values()].flatMap(v => v.pts.map(p => p.ms)).sort((a, b) => a - b);
  out.push(`| ${codec} | ${ms[Math.floor(ms.length / 2)]} |`);
}
console.log(out.join('\n'));
fs.writeFileSync(path.join(__dirname, 'results', 'summary.json'), JSON.stringify(summary, null, 1));
