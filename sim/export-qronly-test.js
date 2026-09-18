'use strict';
// QR 専用モード（docs/research/09 §6）のシェーダ検証用データを書き出す。
// 期待値は PNG ではなく 0/1 の文字列にしてある。マス目そのものを比べたいので、画像にする意味が無い。
//   node export-qronly-test.js "<文字列>" [--bytes 4] [--out ../measure/unity/Assets/ParamroomMeasure/TestData]
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const qo = require('./codecs/qronly');

const opt = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const text = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'https://kumo-mayu.booth.pm';
const bytes = Number(opt('bytes', 4));
const outDir = opt('out', path.join(__dirname, '..', 'measure', 'unity', 'Assets', 'ParamroomMeasure', 'TestData'));
fs.mkdirSync(outDir, { recursive: true });

const L = qo.layout(bytes);
if (!L) throw new Error(`${bytes} Int では割り付けが成立しない`);
const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
const n = q.modules.size;
const modules = new Uint8Array(n * n);
for (let i = 0; i < n * n; i++) modules[i] = q.modules.data[i] ? 1 : 0;
const enc = qo.encode(modules, n, L);

// 受信側が最後に持っているはずのマス目（切り出しパターンは受信側が描くので、元の QR とそのまま一致する）
let grid = '';
for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) grid += modules[y * n + x] ? '1' : '0';

// 各マスがどのパケットに入っているか。途中まで届いた状態の期待値を作るのに使う
const unitOf = [];
for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
  if (qo.skipped(n, x, y)) { unitOf.push(-1); continue; }   // -1 = 受信側が描く
  const j = y * n + x - qo.skippedBefore(n, x, y);
  unitOf.push(j < L.first ? 0 : 1 + Math.floor((j - L.first) / L.pay));
}

const packets = enc.units.map(u => {
  const bits = [0, 1].concat(Array.from(u));               // epoch = 1
  const out = [];
  for (let i = 0; i < bytes; i++) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | (bits[i * 8 + k] || 0); out.push(v); }
  return out;
});

const name = `qronly-${n}x${n}-${bytes}int`;
fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({
  text, version: enc.version, modules: n, bytes, maxSide: qo.sideOf(qo.MAX_VERSION),
  layout: { u: L.u, pay: L.pay, first: L.first, maxUnits: L.maxUnits },
  grid, unitOf, packets,
}));
console.log(`"${text}" -> QR v${enc.version} ${n}x${n}, ${bytes} Int, ${packets.length} パケット（${(packets.length / 10).toFixed(1)} 秒）-> ${outDir}/${name}.json`);
