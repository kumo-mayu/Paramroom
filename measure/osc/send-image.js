'use strict';
// Send an image to the ImagePad prim decoder (256 bit = D0..D31) over OSC.
// usage: node send-image.js <image.png|jpg> [--epoch 1] [--hold 100] [--schedule sqrt|carousel] [--no-bundle]
//                           [--host 127.0.0.1] [--port 9000] [--duration 0 (=forever)] [--fit stretch|crop]
// Encoding: sim/codecs/prim.js config e9.8.6-c565a2-r256-n1000. --fit stretch (default): the whole image is stretched
// to 256x256 and its aspect ratio is sent so the display un-stretches it; --fit crop: centre square crop (1:1).
// Packet: [epoch 2 bits (1..3, never 0)][prim unit 254 bits] -> 32 bytes -> Int parameters D0..D31.
//         The last byte (D31, unused unit padding) carries prim.aspectCode (0 = unknown = 1:1).
// Schedule: square-root rule over the units' distortion gains (docs/design/02 §5.1), hold 100 ms, OSC bundle.
const dgram = require('dgram');
const path = require('path');
const { performance } = require('perf_hooks');
const I = require('../../sim/lib/image');
const prim = require('../../sim/codecs/prim');
const T = require('../../sim/lib/transport');
const { padBits } = require('../../sim/lib/evaluate');

const argv = process.argv.slice(2);
const file = argv[0];
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
if (!file) { console.log('usage: node send-image.js <image> [--epoch 1] [--hold 100] [--schedule sqrt] [--no-bundle]'); process.exit(1); }
const epoch = Math.max(1, Math.min(3, Number(opt('epoch', 1))));
const hold = Number(opt('hold', 100));
const scheduleType = opt('schedule', 'sqrt');
const bundle = !argv.includes('--no-bundle');
const host = opt('host', '127.0.0.1'), port = Number(opt('port', 9000));
const duration = Number(opt('duration', 0));
const fit = opt('fit', 'stretch');

// load + (stretch | centre square crop) to 256x256
let img = I.loadPNG(path.resolve(file));
const aspect = fit === 'crop' ? prim.aspectCode(1, 1) : prim.aspectCode(img.w, img.h);
if (fit === 'crop') { const s = Math.min(img.w, img.h); img = I.crop(img, (img.w - s) >> 1, (img.h - s) >> 1, s, s); }
img = I.resize(img, 256, 256);
const cfg = prim.configs(256).find(c => c.label === 'e9.8.6-c565a2-r256-n1000');
const P = 254;
if (prim.spareBits(prim.layout(cfg, P)) < 8) throw new Error('no spare byte for the aspect code');
console.log('encoding (primitives)...');
const t0 = performance.now();
const enc = prim.encode(img, cfg, P);
console.log(`encoded ${enc.units.length} units in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const packets = enc.units.map(u => {
  const bits = [(epoch >> 1) & 1, epoch & 1].concat(padBits(u, P));
  const bytes = [];
  for (let i = 0; i < 32; i++) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k]; bytes.push(v); }
  bytes[31] = aspect; // unit padding byte
  return bytes;
});
const N = packets.length;
const schedule = scheduleType === 'sqrt' ? T.makeSchedule(N, { type: 'sqrt', alpha: 0 }, 1, enc.gains) : k => k % N;

// OSC
const sock = dgram.createSocket('udp4');
const str = x => { const b = Buffer.from(x + '\0', 'ascii'); return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]); };
const msg = (i, v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return Buffer.concat([str(`/avatar/parameters/D${i}`), str(',i'), b]); };
const bundleOf = ms => { const parts = [str('#bundle'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]; for (const m of ms) { const l = Buffer.alloc(4); l.writeInt32BE(m.length); parts.push(l, m); } return Buffer.concat(parts); };
const send = buf => new Promise(r => sock.send(buf, port, host, r));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`aspect code ${aspect} (w/h ${prim.aspectRatio(aspect).toFixed(3)}, fit ${fit})`);
  console.log(`sending: epoch ${epoch}, hold ${hold} ms, schedule ${scheduleType}, ${bundle ? 'OSC bundle' : 'single messages'}. Ctrl+C to stop.`);
  const start = performance.now();
  for (let k = 0; ; k++) {
    const target = start + k * hold;
    while (performance.now() < target - 2) await sleep(Math.max(0, target - performance.now() - 2));
    const bytes = packets[schedule(k)];
    const ms = bytes.map((v, i) => msg(i, v));
    if (bundle) await send(bundleOf(ms)); else for (const m of ms) await send(m);
    if (k % 50 === 0) process.stdout.write(`\r${k} packets sent (${((performance.now() - start) / 1000).toFixed(0)} s)   `);
    if (duration && performance.now() - start > duration * 1000) break;
  }
  sock.close();
})();
