'use strict';
// Sending a QR code as its modules instead of as a picture (docs/research/09).
//
// A QR code is a grid of black and white squares, so the squares themselves can go into the packets: one bit each.
// A 25x25 code is 625 bits, which is 3 packets - under half a second, against 12 to 27 seconds for the same code sent
// as an image through the primitive codec. The decoder only has to colour a cell by its bit, which is less work than
// drawing an ellipse.
//
// Packet layout (the same shape as the image mode, so the same shader machinery fits):
//   unit 0: [epoch 2][unit id u][size 8][ecc 2][mask 3][payload...]   size = modules per side (21..177)
//   unit i: [epoch 2][unit id u][payload...]                          payload = the module bits, row by row
//
// This measures what actually matters: with packets arriving over a lossy channel, when can a reader read it, and does
// the error correction inside the QR code cover the packets that have not arrived yet?
//   node qr-modules.js <text> [--ec L|M|Q|H] [--loss 0.2] [--seeds 5]
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const T = require('./lib/transport');

const P = 254;              // payload bits of one packet (256 - epoch 2)
const HEADER_BITS = 13;     // size 8 + ecc 2 + mask 3, in unit 0

function modulesOf(text, ec) {
  const q = QRCode.create(text, { errorCorrectionLevel: ec });
  const n = q.modules.size, data = q.modules.data;
  const bits = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) bits[i] = data[i] ? 1 : 0;
  return { n, bits, version: q.version };
}

// how many packets the modules need, and which bits go in which packet
function layout(n, uBits) {
  const pay = P - uBits;
  const first = pay - HEADER_BITS;
  const rest = n * n - first;
  return { pay, first, units: 1 + Math.max(0, Math.ceil(rest / pay)) };
}

// render the modules a viewer would see, given which packets arrived (missing ones stay white)
function render(n, bits, have, L, uBits, scale, quiet) {
  const side = (n + 2 * quiet) * scale;
  const img = { w: side, h: side, c: 3, data: new Float64Array(side * side * 3).fill(255) };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const idx = y * n + x;
      const unit = idx < L.first ? 0 : 1 + Math.floor((idx - L.first) / L.pay);
      if (!have[unit]) continue;             // not arrived: left white
      if (!bits[idx]) continue;              // white module
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const px = ((quiet + y) * scale + dy) * side + (quiet + x) * scale + dx;
        img.data[px * 3] = img.data[px * 3 + 1] = img.data[px * 3 + 2] = 0;
      }
    }
  }
  return img;
}

function read(img, text) {
  const n = img.w * img.h;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = img.data[i * 3 + c];
    rgba[i * 4 + 3] = 255;
  }
  const r = jsQR(rgba, img.w, img.h);
  return r?.data === text;
}

const [text, ...rest] = process.argv.slice(2);
if (!text) { console.log('usage: node qr-modules.js <text> [--ec M] [--loss 0.2] [--seeds 5]'); process.exit(1); }
const opt = (k, d) => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] : d; };
const ec = opt('ec', 'M');
const seeds = Number(opt('seeds', 5));
const losses = (opt('loss', '0,0.1,0.2,0.3,0.4') + '').split(',').map(Number);

const { n, bits, version } = modulesOf(text, ec);
const uBits = 6;                         // 64 units is plenty (a 177x177 code needs 128)
const L = layout(n, uBits);
console.log(`"${text}" (${text.length} 文字) 誤り訂正 ${ec} -> QR v${version} ${n}x${n} = ${n * n} bit`);
console.log(`パケット ${L.units} 個（1 個 ${L.pay} bit、うち先頭は ${L.first} bit）= 全部届くまで ${(L.units * 0.1).toFixed(1)} 秒`);
console.log('');
console.log('取りこぼし  届いたパケット  読めた割合（' + seeds + ' 回）');
for (const loss of losses) {
  let ok = 0, got = 0;
  for (let s = 1; s <= seeds; s++) {
    const rnd = T.mulberry32(s * 7919 + 13);
    const have = new Array(L.units).fill(false);
    for (let i = 0; i < L.units; i++) if (rnd() >= loss) { have[i] = true; got++; }
    if (!have[0]) continue;              // without unit 0 the size is unknown: nothing can be drawn
    if (read(render(n, bits, have, L, uBits, 8, 4), text)) ok++;
  }
  console.log(String((loss * 100).toFixed(0) + ' %').padEnd(12) + (got / seeds).toFixed(1).padEnd(16) + (ok / seeds * 100).toFixed(0) + ' %');
}
