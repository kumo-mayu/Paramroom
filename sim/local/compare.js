'use strict';
// 同じビット数での見比べ画像を作る（docs/research/12）。
//   node local/compare.js [--bpp 0.5,1] [--images a,b] [--codecs a;b]
// 各方式について、rq.jsonl の中から「そのビット数以下で msssimc が最良の設定」を選び、作り直して保存する。
// 出力: measure/results/2026-09-19-local/bpp<X>/<画像>/<方式>.png と、切り出しを横に並べた sheet.png、README.md
const path = require('path');
const fs = require('fs');
const C = require('./common');
const X = require('./codecs');
const I = C.I;

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const budgets = opt('bpp', '0.5,1').split(',').map(Number);
const images = opt('images', 'kodim23,illust_wikipetan_face,screenshot_mahara').split(',');
const codecs = opt('codecs', 'dctc (chunk-packed);dctc (chunk-packed, 4:4:4);wavelet97 (4:4:4);bc1 (4x4,565,2bit=4bpp);blk (8x8,565,2bit=2.5bpp);pal-global;raw-ycc420-6.5;prim-ellipse (1024, C#)').split(';'); // 方式名にカンマを含むので ; で区切る
const rows = ['rq.jsonl', 'rq-prim.jsonl', 'rq2.jsonl'].flatMap(f => {
  const p = path.join(__dirname, 'results', f);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.error) : [];
});
const OUT = path.join(__dirname, '..', '..', 'measure', 'results', '2026-09-19-local');
// 切り出し（元画像の座標、見比べる 256×256）
const CROP = { kodim23: [300, 100, 256, 256], illust_wikipetan_face: [350, 300, 256, 256], screenshot_mahara: [40, 130, 256, 256] };

const readme = ['# 同じビット数での見比べ（docs/research/12）', '', 'シミュレーション。各方式で「そのビット数以下で MS-SSIM(YCbCr) が最良の設定」の復元画像。', '`sheet.png` は左から: 元画像, ' + codecs.join(', ') + '（256×256 の切り出し、等倍）。', ''];
for (const B of budgets) {
  readme.push(`## ${B} bpp`, '');
  for (const im of images) {
    const e = C.loadSet([im])[0];
    const dir = path.join(OUT, `bpp${B}`, im);
    fs.mkdirSync(dir, { recursive: true });
    const crops = [I.crop(e.img, ...CROP[im])];
    readme.push(`### ${im}`, '', '| 方式 | 設定 | bpp | MS-SSIM(YCbCr) | PSNR |', '|---|---|---:|---:|---:|');
    for (const c of codecs) {
      const cand = rows.filter(r => r.codec === c && r.image === im && r.bpp <= B * 1.02).sort((a, b) => b.msssimc - a.msssimc)[0];
      if (!cand) { readme.push(`| ${c} | このビット数では作れない | | | |`); crops.push(I.create(256, 256, 3, 0)); continue; }
      let rec;
      if (c.startsWith('prim')) rec = I.resize(I.loadPNG(path.join(__dirname, 'results', 'prim-tmp', `${im}-${cand.p.n}.png`)), e.img.w, e.img.h);
      else rec = X.run(c, cand.p, e.img).rec;
      I.savePNG(I.quantize8(rec), path.join(dir, c.replace(/[^a-zA-Z0-9.=-]+/g, '_') + '.png'));
      crops.push(I.crop(I.quantize8(rec), ...CROP[im]));
      readme.push(`| ${c} | ${JSON.stringify(cand.p)} | ${cand.bpp.toFixed(3)} | ${cand.msssimc.toFixed(4)} | ${cand.psnr.toFixed(2)} |`);
    }
    readme.push('');
    const sheet = I.create(256 * crops.length + 4 * (crops.length - 1), 256, 3, 255);
    crops.forEach((cr, k) => { for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) for (let ch = 0; ch < 3; ch++) sheet.data[(y * sheet.w + k * 260 + x) * 3 + ch] = cr.data[(y * 256 + x) * 3 + ch]; });
    I.savePNG(sheet, path.join(dir, 'sheet.png'));
  }
}
fs.writeFileSync(path.join(OUT, 'README.md'), readme.join('\n') + '\n');
console.log('wrote', OUT);
