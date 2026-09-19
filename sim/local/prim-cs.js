'use strict';
// 楕円 primitive（現行方式）を C# の符号化器で 1024 キャンバスに作り、ローカル転送の比較に入れる（docs/research/12）。
//   node local/prim-cs.js [--n 4000,8000,16000] [--images a,b] [--out local/results/rq-prim.jsonl]
// 画像全体を 1024×1024 に引き伸ばして符号化し（現行の縦横比の扱いと同じ）、描いた絵を元の大きさに戻して測る。
// ビット数 = 図形数 × 59 bit（1024 用: 座標 10・半径 8・角度 5・色 565・α 2）＋ 背景 16 bit。パケットの枠は数えない。
// 符号化時間は C#（この PC の全スレッド）での値。
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const C = require('./common');
const I = C.I;

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const ns = opt('n', '2000,4000,8000,16000,32000').split(',').map(Number);
const images = opt('images') ? opt('images').split(',') : C.SET.map(([n]) => n);
const out = path.resolve(opt('out', path.join(__dirname, 'results', 'rq-prim.jsonl')));
// Paramroom.Core の PrimEncoder を、パケットの割り付けに縛られずに呼ぶ小さな計測用プログラム（PRIMBENCH で場所を渡す）。
// 中身: Img.Load → Resize(R,R) → new PrimEncoder(new PrimConfig{R,MaxPrims=n,LayoutPrims=n,Cb=10,Ab=5}, img).Encode(4096) → Canvas を PNG に
const exe = process.env.PRIMBENCH || 'primbench.exe';
const tmp = path.join(__dirname, 'results', 'prim-tmp');
fs.mkdirSync(tmp, { recursive: true });
const ws = fs.createWriteStream(out, { flags: 'a' });

for (const name of images) {
  const e = C.loadSet([name])[0];
  const src = path.join(tmp, name + '.png');
  I.savePNG(e.img, src);
  for (const n of ns) {
    const png = path.join(tmp, `${name}-${n}.png`);
    const log = execFileSync(exe, [src, '1024', String(n), png], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const m = log.match(/encoded (\d+) primitives in ([0-9.]+) s/);
    const prims = m ? Number(m[1]) : n;
    const canvas = I.loadPNG(png);
    const rec = I.resize(canvas, e.img.w, e.img.h);
    const q = C.evaluate(e, rec);
    const bits = prims * 59 + 16;
    const r = { codec: 'prim-ellipse (1024, C#)', fam: 'prim', pi: n, p: { n }, image: name, kind: e.kind, w: e.img.w, h: e.img.h, bits, bpp: bits / (e.img.w * e.img.h), ms: m ? Number(m[2]) * 1000 : null, ...q };
    ws.write(JSON.stringify(r) + '\n');
    console.log(name, n, prims, r.bpp.toFixed(3), q.msssimc.toFixed(4), q.psnr.toFixed(2), m ? m[2] + ' s' : '');
  }
}
ws.end();
