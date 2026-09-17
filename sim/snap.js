'use strict';
// Contact sheet: rows = codec configs, columns = time points; one image + scenario.
// usage: node snap.js --image kodim23 --B 256 --ch bm14 --join 0 --policy carousel --cap 90 --crc 0
//        --rows dctv:r256-s2,wav:q24-rd --times 1,2,5,10,20,60 --out out/sheet.png
const path = require('path');
const fs = require('fs');
const I = require('./lib/image');
const M = require('./lib/metrics');
const T = require('./lib/transport');
const { loadCodec, padBits, GRIDS } = require('./lib/evaluate');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
const B = Number(args.B || 256), join = Number(args.join || 0), crcBits = Number(args.crc || 0);
const channel = { ...GRIDS.full.channels.find(c => c.name === (args.ch || 'bm14')), torn: 0 };
const H = channel.H;
const cap = Number(args.cap || 90), seed = Number(args.seed || 1);
const policy = args.policy === 'prio' ? { type: 'prio', period: 4 } : args.policy === 'tier' ? { type: 'tier' } : { type: 'carousel' };
const times = (args.times || '1,2,5,10,20,60').split(',').map(Number);
const rows = args.rows.split(',').map(s => s.split(':'));
const ref = I.loadPNG(path.join(__dirname, 'images', 'ref', args.image + '.png'));
const P = B - T.EPOCH_BITS - crcBits;
const S = 256, PAD = 4;
const sheet = I.create((times.length + 1) * (S + PAD), rows.length * (S + PAD), 3, 255);
function blit(img, cx, cy) {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) for (let k = 0; k < 3; k++)
    sheet.data[((cy + y) * sheet.w + cx + x) * 3 + k] = img.data[(y * S + x) * 3 + k];
}
rows.forEach(([codecName, label], ri) => {
  const codec = loadCodec(codecName);
  const cfg = codec.configs(B).find(c => c.label === label);
  if (!cfg) throw new Error(`no cfg ${label} for ${codecName} B=${B}`);
  const enc = codec.encode(ref, cfg, P);
  const units = enc.units.map(u => padBits(u, P));
  const dual = enc.schedule && enc.schedule.type === 'dual';
  const N = Math.min(units.length, (dual ? enc.baseCount : 0) + Math.floor(cap / H));
  const baseCount = Math.min(Math.max(enc.baseCount || 0, Math.ceil(N * 0.1)), N);
  const sched = enc.schedule ? T.makeSchedule(N, enc.schedule, enc.baseCount) : T.makeSchedule(N, policy, baseCount);
  const arr = T.arrivals({ schedule: sched, H, channel, join, tMax: Math.max(...times), seed: seed * 7919 + 13, packetBytes: B / 8 });
  const dec = codec.decoder(cfg, P);
  let ai = 0;
  blit(ref, 0, ri * (S + PAD));
  const line = [];
  times.forEach((t, ti) => {
    while (ai < arr.length && arr[ai].time <= t + 1e-9) dec.apply(units[arr[ai++].unit]);
    const img = ai ? dec.render() : I.create(S, S, 3, 128);
    blit(img, (ti + 1) * (S + PAD), ri * (S + PAD));
    const m = M.all(ref, img);
    line.push(`t=${t}: ${m.psnr.toFixed(1)}dB msssimc ${m.msssimc.toFixed(3)}`);
  });
  console.log(`${codecName}:${label} (N=${N}/${units.length})  ` + line.join(' | '));
});
const out = args.out || `out/sheet-${args.image}-${B}.png`;
fs.mkdirSync(path.dirname(out), { recursive: true });
I.savePNG(sheet, out);
console.log('saved', out);
