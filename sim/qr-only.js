'use strict';
// QR 専用モード（docs/research/09 §6）。
//
// いまの QR モードは画像モードのパケット割り付けをそのまま借りている。つまり「図形 1 個ぶん」の枠に
// モジュールを詰めるので、図形 1 個（47〜59 bit）が 1 パケットに入らない Int 数では成立しない。
// 形式 3 で 10 Int、形式 4 で 9 Int が下限になるのはそのためで、QR 自体の要求ではない。
//
// QR しか出さない受信側なら、枠は要らない。パケットは [epoch 2][ユニット番号 u][中身] だけでよく、
// 中身は 1 bit = 1 モジュールとして端から詰められる。何 Int まで下げられるかを測る。
//
// 2 つの設計を比べる:
//   A 全マス送る        n*n bit。受信側は届いたマスを塗るだけ（いまの QR モードと同じ考え方）
//   B データマスだけ送る 切り出し・タイミング・位置合わせ・形式情報は版と誤り訂正レベルとマスクから
//                       決まるので受信側が描ける。送るのはデータ領域だけで、
//                       ヘッダは 版 6 bit ＋ 誤り訂正 2 bit ＋ マスク 3 bit ＝ 11 bit
//
//   node qr-only.js [--ec M] [--read]     --read を付けると「何パケットで読めるか」も測る
const QRCode = require('qrcode');
const jsQR = require('jsqr');

const opt = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const ec = opt('ec', 'M');
const doRead = process.argv.includes('--read');

const HEAD_A = 6;    // 版 6 bit（大きさは 17 + 4v で決まる）
const HEAD_B = 11;   // 版 6 ＋ 誤り訂正 2 ＋ マスク 3。形式情報の 15 bit は 32 通りなので受信側の表で引ける

// 狙った版ちょうどになる文字列を作る
function textOfVersion(v) {
  let s = 'a';
  for (;;) {
    const q = QRCode.create(s, { errorCorrectionLevel: ec });
    if (q.version === v) return { text: s, q };
    if (q.version > v) return null;
    s += 'a';
  }
}

function bitsOf(q) {
  const n = q.modules.size, res = q.modules.reservedBit;
  const data = [];                       // データマスの位置（行優先）
  for (let i = 0; i < n * n; i++) if (!res[i]) data.push(i);
  return { n, all: n * n, data };
}

// [epoch 2][ユニット番号 u][中身]。先頭パケットだけ head bit をヘッダに使う
function units(totalBits, head, bytes) {
  const P = 8 * bytes - 2;
  for (let u = 1; u <= 12; u++) {
    const pay = P - u;
    if (pay <= head) continue;
    const need = 1 + Math.max(0, Math.ceil((totalBits - (pay - head)) / pay));
    if (need <= (1 << u)) return { u, pay, first: pay - head, need };
  }
  return null;
}

// 届いたパケットの範囲だけ塗った絵（scale 倍、余白 quiet マス）
function render(q, idxOf, arrived, design, scale, quiet) {
  const n = q.modules.size, m = q.modules.data, res = q.modules.reservedBit;
  const side = (n + 2 * quiet) * scale;
  const img = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let i = 0; i < side * side; i++) img[i * 4 + 3] = 255;
  const put = (x, y) => {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const p = (((quiet + y) * scale + dy) * side + (quiet + x) * scale + dx) * 4;
      img[p] = img[p + 1] = img[p + 2] = 0;
    }
  };
  for (let i = 0; i < n * n; i++) {
    const isData = !res[i];
    // B では関数パターンは常に描ける。A では届いたマスだけ
    const known = design === 'B' ? (!isData || arrived.has(idxOf.get(i))) : arrived.has(idxOf.get(i));
    if (known && m[i]) put(i % n, (i / n) | 0);
  }
  return { img, side };
}

function reads(r, text) {
  const out = jsQR(r.img, r.side, r.side);
  return out?.data === text;
}

const vers = [1, 2, 3, 4, 5, 7, 10];
const ints = [2, 3, 4, 5, 6, 8, 10, 16, 32];

console.log(`誤り訂正 ${ec}。表の数字は「全部そろうまでの秒数」（100 ms/パケット）。- は入らない\n`);
const cases = [];
for (const [name, head, pick] of [['A 全マス', HEAD_A, 'all'], ['B データマスだけ', HEAD_B, 'data']]) {
  console.log(`## ${name}`);
  console.log('| 版 | 大きさ | 送る bit | ' + ints.map(b => b + ' Int').join(' | ') + ' |');
  console.log('|---|---|---:|' + ints.map(() => '---:|').join(''));
  for (const v of vers) {
    const t = textOfVersion(v);
    if (!t) continue;
    const b = bitsOf(t.q);
    const total = pick === 'all' ? b.all : b.data.length;
    const cells = ints.map(B => {
      const r = units(total, head, B);
      if (r && v === 2) cases.push({ design: name[0], B, r, t, b, pick });
      return r ? (r.need / 10).toFixed(1) : '-';
    });
    console.log(`| v${v} | ${b.n}x${b.n} | ${total} | ${cells.join(' | ')} |`);
  }
  console.log('');
}

if (!doRead) process.exit(0);

// 何パケット届いた時点で読めるか（先頭から順に届く前提）
console.log('## 25x25（v2）を、届いたパケット数ごとに読めるか\n');
console.log('| 設計 | Int | 全部そろう | 読めた時点 | 短縮 |');
console.log('|---|---:|---:|---:|---:|');
for (const c of cases) {
  const { design, B, r, t, b, pick } = c;
  const n = b.n;
  const idxOf = new Map();               // マス番号 -> どのパケットに入っているか
  const list = pick === 'all' ? Array.from({ length: n * n }, (_, i) => i) : b.data;
  for (let j = 0; j < list.length; j++) {
    const unit = j < r.first ? 0 : 1 + Math.floor((j - r.first) / r.pay);
    idxOf.set(list[j], unit);
  }
  let firstOk = null;
  for (let got = 1; got <= r.need; got++) {
    const arrived = new Set(Array.from({ length: got }, (_, i) => i));
    if (reads(render(t.q, idxOf, arrived, design, 8, 4), t.text)) { firstOk = got; break; }
  }
  const full = (r.need / 10).toFixed(1), part = firstOk ? (firstOk / 10).toFixed(1) : '-';
  const cut = firstOk ? ((1 - firstOk / r.need) * 100).toFixed(0) + ' %' : '-';
  console.log(`| ${design} | ${B} | ${full} 秒 | ${part} 秒 | ${cut} |`);
}
