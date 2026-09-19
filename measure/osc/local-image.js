'use strict';
// Paramroom local image - OSC sender (docs/research/13). Sends an image file to the wearer's OWN avatar
// (ParamroomLocalImage prefab: local, not synced Float parameters PRL0..PRL{K-1}; nothing reaches other players).
//
//   node local-image.js send <image.png|jpg> [--quality 85] [--max 1024] [--k 512] [--rate 90] [--passes 2]
//                                            [--jack 1] [--read]
//   node local-image.js jack 0|1           # the photo camera shows the image (1) or the world (0)
//   node local-image.js hud 0|1
//   common: [--host 127.0.0.1] [--port 9000]
//
// The image is encoded with sim/local/lpic.js (baseline-JPEG-like, 4:4:4) into chunks of 31 x 28 bits; one send carries
// one chunk per group of 32 parameters (one group per OSC bundle / datagram: VRChat drops datagrams over ~4 KB).
// Chunk order per pass: the header chunk, then the data chunks; passes repeat the whole set (there is no feedback;
// a chunk lost in one pass comes again in the next). At the end all data parameters go back to 0 (holding non-zero
// values costs frame time, docs/research/12). --read prints the overlay's statistics afterwards.
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const L = require(path.join(__dirname, '..', '..', 'sim', 'local', 'lpic.js'));
const I = require(path.join(__dirname, '..', '..', 'sim', 'lib', 'image.js'));

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const host = opt('host', '127.0.0.1'), port = Number(opt('port', 9000));
const sock = dgram.createSocket('udp4');
const send = buf => new Promise((res, rej) => sock.send(buf, port, host, e => (e ? rej(e) : res())));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function oscString(s) { const b = Buffer.from(s + '\0', 'ascii'); return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]); }
const FLOAT_TAG = oscString(',f');
function floatBitsMsg(addrBuf, bits) {
  const m = Buffer.alloc(addrBuf.length + 8);
  addrBuf.copy(m, 0); FLOAT_TAG.copy(m, addrBuf.length); m.writeUInt32BE(bits >>> 0, addrBuf.length + 4);
  return m;
}
function floatMsg(addr, v) { const a = oscString(addr), m = Buffer.alloc(a.length + 8); a.copy(m, 0); FLOAT_TAG.copy(m, a.length); m.writeFloatBE(v, a.length + 4); return m; }
const BUNDLE_HEAD = Buffer.concat([oscString('#bundle'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]);
function bundle(msgs) { const parts = [BUNDLE_HEAD]; for (const m of msgs) { const len = Buffer.alloc(4); len.writeInt32BE(m.length); parts.push(len, m); } return Buffer.concat(parts); }
const enc = (tag, payload) => (((tag & 3) << 28 | (payload & 0x0FFFFFFF)) >>> 0) + 0x00800000;
const setParam = (name, v) => send(floatMsg(`/avatar/parameters/${name}`, v));

async function sendImage() {
  const file = argv[1];
  const quality = Number(opt('quality', 85)), max = Number(opt('max', 1024));
  const K = Number(opt('k', 512)), G = K / 32, rate = Number(opt('rate', 90)), passes = Number(opt('passes', 2));
  const t0 = performance.now();
  const img = I.quantize8(L.fit(L.loadAny(file), max));
  const lp = L.encode(img, quality);
  const tEnc = performance.now() - t0;
  const N = lp.chunks.length;
  const addrs = Array.from({ length: K }, (_, i) => oscString(`/avatar/parameters/PRL${i}`));
  const session = 1 + Math.floor(Math.random() * 1e6);
  await setParam('PRS', session);
  if (opt('jack', null) !== null) await setParam('PRJ', Number(opt('jack', 1)));
  await sleep(300);

  const order = [];
  for (let p = 0; p < passes; p++) for (let c = 0; c < N; c++) order.push(c);
  const sends = Math.ceil(order.length / G), period = 1000 / rate;
  const tSend = performance.now();
  for (let s = 0; s < sends; s++) {
    const due = tSend + s * period, now = performance.now();
    if (now < due - 2) await sleep(due - now - 2);
    while (performance.now() < due) { /* spin */ }
    for (let g = 0; g < G; g++) {
      const idx = s * G + g;
      if (idx >= order.length) break;
      const c = order[idx], words = lp.chunks[c];
      const msgs = [floatBitsMsg(addrs[g * 32], enc(s, c))];
      for (let j = 1; j < 32; j++) msgs.push(floatBitsMsg(addrs[g * 32 + j], enc(s, words[j - 1])));
      await send(bundle(msgs));
    }
  }
  const sendMs = performance.now() - tSend;
  await sleep(100);
  for (let g = 0; g < G; g++) await send(bundle(Array.from({ length: 32 }, (_, j) => floatBitsMsg(addrs[g * 32 + j], 0))));
  const result = { file: path.basename(file), w: lp.w, h: lp.h, quality, chunks: N, bits: N * 868, bpp: +(N * 868 / (lp.w * lp.h)).toFixed(3),
    encodeMs: Math.round(tEnc), k: K, rate, passes, sends, sendMs: Math.round(sendMs), session };
  if (opt('read', false)) {
    await sleep(Number(opt('tail', 1500)));
    const s = JSON.parse(execFileSync('node', [path.join(__dirname, 'local-probe-read.js'), '--image']).toString());
    Object.assign(result, { hud: s });
  }
  console.log(JSON.stringify(result));
}

(async () => {
  try {
    if (cmd === 'send') await sendImage();
    else if (cmd === 'jack') await setParam('PRJ', Number(argv[1] ?? 1));
    else if (cmd === 'hud') await setParam('PRH', Number(argv[1] ?? 1));
    else { console.log('usage: node local-image.js send <image> [...] | jack 0|1 | hud 0|1 (see the header)'); process.exitCode = 1; }
  } catch (e) { console.error(e.stack || e.message); process.exitCode = 1; }
  sock.close();
})();
