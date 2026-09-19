'use strict';
// summary.json の「閾値に届く bpp」から、転送にかかる秒数の表を作る（docs/research/12）。
//   node local/times.js [--mpx 1.0] [--metric msssimc] [--T 0.98]
// 秒数 = ceil(bpp × 画素数 / 868) チャンク ÷ (K/32 × 有効率 0.9 × fps)。K = パラメータ数、1 フレーム 1 送信。
// スループットは仮置き（実機で置き換える）。
const fs = require('fs');
const path = require('path');
const C = require('./common');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const mpx = Number(opt('mpx', 1.0));
const metric = opt('metric', 'msssimc');
const T = opt('T', '0.98');
const kind = opt('kind', metric === 'text_msssimc' ? 'screen' : 'all');
const S = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'summary.json'), 'utf8'));
const Ks = [256, 512, 1024], fpss = [30, 60, 90];
const rows = [];
for (const [key, v] of Object.entries(S)) {
  const [codec, m, t, k] = key.split('|');
  if (m !== metric || t !== T || k !== kind || v.bpp == null) continue;
  rows.push({ codec, bpp: v.bpp, reached: v.reached, n: v.n });
}
rows.sort((a, b) => a.bpp - b.bpp);
const px = mpx * 1e6;
console.log(`| 方式 | bpp | ${metric} ${T} 届いた枚数 | ビット数（${mpx} Mpx） | ` + Ks.flatMap(K => fpss.map(f => `K=${K} ${f}fps`)).join(' | ') + ' |');
console.log('|---|---:|---:|---:|' + Ks.flatMap(() => fpss.map(() => '---:')).join('|') + '|');
for (const r of rows) {
  const bits = r.bpp * px;
  const cells = Ks.flatMap(K => fpss.map(f => C.seconds(bits, K, f).toFixed(1)));
  console.log(`| ${r.codec} | ${r.bpp.toFixed(2)} | ${r.reached}/${r.n} | ${(bits / 1e6).toFixed(2)} Mbit | ${cells.join(' | ')} |`);
}
