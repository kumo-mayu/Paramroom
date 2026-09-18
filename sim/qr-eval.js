'use strict';
// Can a QR code survive this codec, and how long does it take? (docs/research/09)
//
// A QR code is the opposite of what the primitive codec is good at: hard black and white squares with no smooth areas.
// This encodes real QR images through the normal path and asks a QR reader (jsQR) to read the result after n packets,
// which answers both "is it readable at all" and "how many seconds until it is".
//   node qr-eval.js <text> [--sizes 256,512] [--fit stretch|crop] [--quiet 4]
//   node qr-eval.js summary
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const I = require('./lib/image');
const M = require('./lib/metrics');
const primx = require('./codecs/primx');
const SHAPE = require('./lib/shape-variants');

const P = 254;
const out = path.join(__dirname, 'results', 'qreval.jsonl');
// packets to try (1 packet = 100 ms)
const KS = [50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300, 350, 400, 500, 700, 1001];

async function qrImage(text, canvas, quiet) {
  // one QR module must land on a whole number of canvas pixels, or the reader sees blurred edges
  const png = await QRCode.toBuffer(text, { type: 'png', errorCorrectionLevel: 'M', margin: quiet, width: canvas, scale: undefined });
  fs.mkdirSync(path.join(__dirname, 'cache', 'qr'), { recursive: true });
  const p = path.join(__dirname, 'cache', 'qr', `qr-${canvas}-${quiet}-${Buffer.from(text).toString('hex').slice(0, 24)}.png`);
  fs.writeFileSync(p, png);
  return I.loadPNG(p);
}

function readQr(img) {
  // jsQR wants RGBA bytes
  const n = img.w * img.h;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.max(0, Math.min(255, Math.round(img.data[i * 3 + c])));
    rgba[i * 4 + 3] = 255;
  }
  const r = jsQR(rgba, img.w, img.h);
  return r ? r.data : null;
}

(async () => {
  const [text, ...rest] = process.argv.slice(2);
  if (!text || text === 'summary') {
    const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
    const lines = ['# QR コードをこの方式で送れるか', '',
      '`sim/qr-eval.js`。QR 画像を通常どおり符号化し、n パケット届いた時点の絵を QR 読み取り器（jsQR）にかけた。',
      '1 パケット 100 ms なので、n パケット ≒ n/10 秒。', '',
      '| 文字列の長さ | QR の型 | キャンバス | 余白 | 読めた最小パケット数 | 秒 | そのときの MS-SSIM |',
      '|---:|---|---:|---:|---:|---:|---:|'];
    for (const r of rows) lines.push(`| ${r.chars} | ${r.version} (${r.modules}x${r.modules}) | ${r.canvas} | ${r.quiet} | ${r.firstOk ?? '読めず'} | ${r.firstOk ? (r.firstOk / 10).toFixed(1) : '-'} | ${r.qAt ?? '-'} |`);
    const p = path.join(__dirname, 'results', 'qreval.md');
    fs.writeFileSync(p, lines.join('\n'));
    console.log(lines.join('\n'));
    return;
  }
  const opt = n => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : null; };
  const canvases = (opt('sizes') || '512').split(',').map(Number);
  const quiet = Number(opt('quiet') ?? 4);
  const fit = opt('fit') || 'stretch';

  for (const canvas of canvases) {
    const ref = await qrImage(text, canvas, quiet);
    // how many modules the code has (for the report)
    const info = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const modules = info.modules.size;
    const cfg = SHAPE.cfgFor('rfx', canvas, P);
    const enc = primx.encode(ref, cfg, P);
    const { padBits } = require('./lib/evaluate');
    const units = enc.units.map(u => padBits(u, P));
    const order = enc.gains.map((g, i) => [i, g === null ? Infinity : g]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    let firstOk = null, qAt = null;
    for (const k of KS) {
      const dec = primx.decoder(cfg, P);
      for (const u of order.slice(0, Math.min(k, units.length))) dec.apply(units[u]);
      const img = dec.render();
      const got = readQr(img);
      const q = M.all(ref, img).msssimc;
      const ok = got === text;
      console.log(`${canvas}px ${k} パケット (${(k / 10).toFixed(1)} 秒): ${ok ? '読めた' : got ? '別の文字列' : '読めず'}  MS-SSIM ${q.toFixed(4)}`);
      if (ok && firstOk === null) { firstOk = k; qAt = +q.toFixed(4); if (!process.env.QR_FULL) break; }
    }
    fs.appendFileSync(out, JSON.stringify({ text, chars: text.length, version: 'v' + info.version, modules, canvas, quiet, fit, firstOk, qAt }) + '\n');
  }
})();
