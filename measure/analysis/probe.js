'use strict';
// Quick live probe: send one fixed packet (held), capture the desktop, decode all boards, print OSC echo of D params.
// usage: node probe.js [--seq 4660] [--mode 0] [--epoch 5] [--wait 1500]
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');
const { makePacket } = require('../osc/packet');
const B = require('./board');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
const seq = opt('seq', 4660), mode = opt('mode', 0), epoch = opt('epoch', 5), wait = opt('wait', 1500);
const bi = argv.indexOf('--bytes');
const bytes = bi >= 0 ? argv[bi + 1].split(',').map(Number) : argv.includes('--zero') ? new Array(32).fill(0) : makePacket(32, seq, mode, epoch);

const tx = dgram.createSocket('udp4'), rx = dgram.createSocket('udp4');
const echo = new Map();
rx.on('message', m => {
  const a = m.toString('ascii', 0, m.indexOf(0));
  const mm = a.match(/^\/avatar\/parameters\/D(\d+)$/);
  if (!mm) return;
  let p = (a.length + 4) & ~3; // skip address + padding
  const tag = m.toString('ascii', p, m.indexOf(0, p)); p = (p + tag.length + 4) & ~3;
  const v = tag === ',i' ? m.readInt32BE(p) : tag === ',f' ? m.readFloatBE(p) : NaN;
  echo.set(+mm[1], v);
});
rx.on('error', e => console.log('echo listener unavailable:', e.code));
rx.bind(9001);
setTimeout(() => { console.log('probe timeout'); process.exit(2); }, 45000);

function oscInt(address, value) {
  const s = x => { const b = Buffer.from(x + '\0'); return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]); };
  const v = Buffer.alloc(4); v.writeInt32BE(value);
  return Buffer.concat([s(address), s(',i'), v]);
}
(async () => {
  for (let i = 0; i < 32; i++) tx.send(oscInt(`/avatar/parameters/D${i}`, bytes[i]), 9000, '127.0.0.1');
  await new Promise(r => setTimeout(r, wait));
  const shot = path.join(__dirname, 'synthetic', 'probe.png');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${shot.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png)`]);
  const png = PNG.sync.read(fs.readFileSync(shot));
  const W = png.width, H = png.height, f = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { f[i * 3] = png.data[i * 4]; f[i * 3 + 1] = png.data[i * 4 + 1]; f[i * 3 + 2] = png.data[i * 4 + 2]; }
  console.log('sent   ', bytes.join(','));
  console.log('echo   ', Array.from({ length: 32 }, (_, i) => echo.has(i) ? echo.get(i) : '?').join(','));
  const boards = B.detectBoards(f, W, H);
  boards.forEach((b, i) => console.log(`board ${i} @${b.x},${b.y} ${b.w}x${b.h} mirror=${b.mirrorX}`, JSON.stringify(B.decodeBoard(f, W, b, H))));
  if (!boards.length) console.log('no boards found in screenshot', shot);
  process.exit(0);
})();
