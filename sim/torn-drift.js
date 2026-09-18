'use strict';
// 画像が完成したあと、送信を続けているとだんだん絵が乱れてくる件（docs/research/10）。
//
// 受信側は届いたパケットを**そのまま**置き場に書く。VRChat が OSC バンドルを 1 フレームで
// 適用しきれないと、途中まで新しいパケット・残りが古いパケットという半端な値が見える
// （実測 0.3%、docs/measure/results-2026-09-17.md 2.3）。それを書いてしまうと、その図形は
// 壊れたまま残り、次に同じユニットが正しく届くまで直らない。送信は完成後も続くので、
// **壊れた図形が少しずつ溜まっていく**。これがどのくらいの速さで進むかを測る。
//
//   node torn-drift.js [image=kodim23] [--minutes 30] [--tear 0.0033] [--hold 100] [--seeds 3]
const path = require('path');
const I = require('./lib/image');
const M = require('./lib/metrics');
const prim = require('./codecs/prim');
const T = require('./lib/transport');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : Number(argv[i + 1]); };
const name = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'kodim23';
const minutes = opt('minutes', 30), tear = opt('tear', 1 / 299), hold = opt('hold', 100), seeds = opt('seeds', 3);

const R = 512, NB = 32, P = 8 * NB - 2;
const cfg = { ...prim.cfgOf({ shape: 'ell', cb: 9, rb: 8, ab: 6, col: [5, 6, 5], aBits: 2, R, maxPrims: 4000 }), out: R };
const src = I.loadPNG(path.join(__dirname, 'images', 'ref', name + '.png'));
const img = I.resize(src, R, R);
const enc = prim.encode(img, cfg, P);
const units = enc.units;
console.log(`${name} 512/4000 32 Int: ${units.length} パケット（1 周 ${(units.length * hold / 1000).toFixed(0)} 秒）`);
console.log(`半端パケットの割合 ${(tear * 100).toFixed(2)} %（実測 1/299、OSC バンドル使用時）\n`);

// 完成した絵（すべて正しく届いた状態）
const perfect = (() => {
  const d = prim.decoder(cfg, P);
  for (const u of units) d.apply(u);
  return I.quantize8(d.render());
})();
const ref = I.quantize8(img);
console.log(`完成した絵の MS-SSIM: ${M.msssim(ref, perfect).toFixed(4)}\n`);

// 半端パケット: 先頭 m バイトが新しいパケット、残りが 1 つ前のパケット
function tearBits(cur, prev, m) {
  const out = cur.slice();
  for (let b = m * 8 - 2; b < P; b++) out[b] = prev[b];   // epoch 2 bit ぶん前にずれている
  return out;
}

// 1 周目は普通に届いて完成する前提。そこからの経過で見る。
const lapMin = units.length * hold / 60000;
const marksAt = [1, 2, 5, 10, 20, 30].filter(m => m <= minutes);
const rows = [];
for (let s = 1; s <= seeds; s++) {
  const rnd = T.mulberry32(s * 104729 + 7);
  const dec = prim.decoder(cfg, P);
  for (const u of units) dec.apply(u);              // 完成した状態から始める
  const good = units.map(u => u.join(''));          // 正しいユニットの中身
  const held = units.map(u => u.join(''));          // 受信側がいま持っているもの
  let prevSent = units[units.length - 1], torn = 0;
  const marks = new Map();
  const totalPackets = Math.round(minutes * 60 * 1000 / hold);
  // 送信側の既定と同じ送り順（fast+sqrt/8 の第 1 周が終わったあとの定常状態 = sqrt の規則）。
  // 均等な総当たりではなく、利得の平方根に比例した頻度なので、後ろのユニットほど戻ってこない。
  const order = T.makeSchedule(units.length, { type: 'sqrt', alpha: 0 }, 1, enc.gains);
  for (let t = 0; t < totalPackets; t++) {
    const idx = order(t), u = units[idx];
    if (rnd() < tear) {
      const m = 1 + Math.floor(rnd() * (NB - 1));
      const bad = tearBits(u, prevSent, m);
      dec.apply(bad); held[idx] = bad.join(''); torn++;
    } else { dec.apply(u); held[idx] = good[idx]; }
    prevSent = u;
    const minute = (t + 1) * hold / 60000;
    for (const mm of marksAt) {
      if (!marks.has(mm) && minute >= mm) {
        const broken = held.reduce((a, h, i) => a + (h === good[i] ? 0 : 1), 0);
        marks.set(mm, { ms: M.msssim(ref, I.quantize8(dec.render())), torn, broken });
      }
    }
  }
  rows.push(marks);
}

console.log(`1 周 ${lapMin.toFixed(1)} 分。完成した状態から送り続けたときの変化:\n`);
console.log('| 経過 | MS-SSIM（平均） | 完成時からの下がり | 壊れているユニット数 | 累計の半端パケット |');
console.log('|---:|---:|---:|---:|---:|');
const base = M.msssim(ref, perfect);
for (const mm of marksAt) {
  const got = rows.map(r => r.get(mm)).filter(Boolean);
  if (!got.length) continue;
  const avg = k => got.reduce((a, b) => a + b[k], 0) / got.length;
  console.log(`| ${mm} 分 | ${avg('ms').toFixed(4)} | ${(base - avg('ms')).toFixed(4)} | ${avg('broken').toFixed(1)} | ${avg('torn').toFixed(1)} |`);
}
