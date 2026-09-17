'use strict';
// Listen for OSC bundles from a sender (e.g. tools/ImagePadTool send --port 9123) and check them against the units
// file: every bundle must carry D0..D31 as ,i whose 32 bytes equal [epoch][unit][aspect] of one unit; reports send
// interval statistics.
// usage: node check-sender.js <units.json> [--port 9123] [--epoch 1] [--seconds 5]
const dgram = require('dgram');
const fs = require('fs');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const j = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
const port = Number(opt('port', 9123)), epoch = Number(opt('epoch', 1)), seconds = Number(opt('seconds', 5));
const expected = new Map(j.units.map((u, id) => {
  const bits = [(epoch >> 1) & 1, epoch & 1, ...[...u].map(Number)];
  const NB = j.bytes || 32;
  const bytes = [];
  for (let i = 0; i < NB; i++) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k]; bytes.push(v); }
  bytes[NB - 1] = j.aspect;
  return [bytes.join(','), id];
}));

const str = (b, o) => { let e = o; while (b[e] !== 0) e++; return [b.toString('ascii', o, e), (e + 4) & ~3]; };
let n = 0, bad = 0; const times = [], seen = new Set(), order = [];
const sock = dgram.createSocket('udp4');
sock.on('message', buf => {
  times.push(process.hrtime.bigint());
  let [tag, o] = str(buf, 0);
  if (tag !== '#bundle') { bad++; return; }
  o += 8;
  const vals = new Array(j.bytes || 32).fill(-1);
  while (o < buf.length) {
    const size = buf.readInt32BE(o); o += 4;
    const [addr, o2] = str(buf, o); const [types, o3] = str(buf, o2);
    const m = /^\/avatar\/parameters\/D(\d+)$/.exec(addr);
    if (m && types === ',i' && Number(m[1]) < vals.length) vals[Number(m[1])] = buf.readInt32BE(o3); else bad += 0;
    o += size;
  }
  const id = expected.get(vals.join(','));
  if (id === undefined) bad++; else { seen.add(id); order.push(id); }
  n++;
});
sock.bind(port, () => console.log(`listening on ${port} for ${seconds} s`));
setTimeout(() => {
  sock.close();
  const d = times.slice(1).map((t, i) => Number(t - times[i]) / 1e6);
  const mean = d.reduce((a, b) => a + b, 0) / d.length, sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
  console.log(`bundles ${n}, not matching a unit ${bad}, distinct units ${seen.size}`);
  console.log(`first units: ${order.slice(0, 20).join(' ')}`);
  console.log(`interval mean ${mean.toFixed(2)} ms, sd ${sd.toFixed(2)} ms, min ${Math.min(...d).toFixed(2)}, max ${Math.max(...d).toFixed(2)}`);
}, seconds * 1000);
