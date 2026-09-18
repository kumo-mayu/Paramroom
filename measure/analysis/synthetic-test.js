'use strict';
// End-to-end self test of the analysis pipeline with a synthetic recording (no VRChat needed).
// Simulates: sender log (hold 150 ms and 100 ms runs) -> local board (shows each packet 1 frame after send)
// and remote board (sampled with the bmfit hypothesis: interval U[100,180] ms, +150 ms latency, 5% torn for 3 frames)
// -> renders both boards (JS re-implementation of the shader layout) into an H.264 video -> decode-video -> analyze.
// Prints ground-truth loss next to the analysis report.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('ffmpeg-static');
const { makePacket, checkPacket } = require('../osc/packet');

const outDir = path.join(__dirname, 'synthetic');
fs.mkdirSync(outDir, { recursive: true });
const FPS = 60, W = 640, H = 360, N = 32;
let rs = 12345;
const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// sender log
const runs = [{ epoch: 1, hold: 150, count: 120 }, { epoch: 2, hold: 100, count: 150 }];
const log = [];
let t = 1000, seq = 1;
for (const r of runs) {
  for (let k = 0; k < r.count; k++) { log.push({ seq, mode: 0, epoch: r.epoch, holdMs: r.hold, sendStartMs: t }); seq++; t += r.hold; }
  t += 1000;
}
const tEnd = t + 1000;
const logPath = path.join(outDir, 'sender.csv');
fs.writeFileSync(logPath, 'seq,mode,epoch,holdMs,sendStartMs,sendEndMs,unixMs,bundle,order,msgDelay\n' +
  log.map(l => `${l.seq},0,${l.epoch},${l.holdMs},${l.sendStartMs},${l.sendStartMs + 1},0,0,forward,0`).join('\n') + '\n');
const packetAt = ms => { let p = null; for (const l of log) { if (l.sendStartMs <= ms) p = l; else break; } return p; };

// remote timeline: snapshots
const remoteEvents = []; // {time, bytes}
const truthRemote = new Set();
let s = 500, prevSlot = null;
while (s < tEnd) {
  const p = packetAt(s);
  if (p) {
    let bytes = makePacket(N, p.seq, 0, p.epoch);
    const changed = !prevSlot || prevSlot.seq !== p.seq;
    if (changed && prevSlot && rnd() < 0.05) {
      const old = makePacket(N, prevSlot.seq, 0, prevSlot.epoch), j = 1 + Math.floor(rnd() * (N - 1));
      const torn = bytes.slice(0, j).concat(old.slice(j));
      remoteEvents.push({ time: s + 150, bytes: torn });
      remoteEvents.push({ time: s + 150 + 3000 / FPS, bytes }); // clean value 3 frames later
    } else remoteEvents.push({ time: s + 150, bytes });
    truthRemote.add(`${p.epoch}:${p.seq}`);
    prevSlot = p;
  }
  s += 100 + 80 * rnd();
}

// board renderer (same layout as ParamroomMeasureBoard.shader)
function drawBoard(img, x0, y0, size, bytes, isLocal, loop) {
  const set = (x, y, r, g, b) => { const o = (y * W + x) * 3; img[o] = r; img[o + 1] = g; img[o + 2] = b; };
  const chk = checkPacket(bytes, N);
  const allZero = bytes.every(v => v === 0);
  const bitsOf = (v, n) => Array.from({ length: n }, (_, i) => (v >> (n - 1 - i)) & 1);
  const mism = []; for (let j = 4; j < 32; j++) mism.push(0);
  const cells = [
    ...bitsOf((bytes[0] << 8) | bytes[1], 16), ...bitsOf(bytes[2], 8),
    chk.consistent ? 1 : 0, 1, isLocal, 0, bytes[3] ? 1 : 0, allZero ? 1 : 0, 0, 1,
    ...mism, 0, 0, 0, 0, ...bitsOf(loop, 24), ...bitsOf(bytes[3], 8),
  ];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size, v = 1 - y / size, fw = 0.04;
      if (u < fw || u > 1 - fw || v < fw || v > 1 - fw) { if (u < 0.2 && v > 0.8) set(x0 + x, y0 + y, 0, 255, 255); else set(x0 + x, y0 + y, 255, 0, 255); continue; }
      const gx = (u - fw) / (1 - 2 * fw), gy = 1 - (v - fw) / (1 - 2 * fw);
      const col = Math.min(7, Math.floor(gx * 8)), row = Math.min(11, Math.floor(gy * 12));
      const fu = gx * 8 - col, fv = gy * 12 - row;
      if (fu < 0.08 || fu > 0.92 || fv < 0.08 || fv > 0.92) { set(x0 + x, y0 + y, 128, 128, 128); continue; }
      const c = cells[row * 8 + col] ? 255 : 0;
      set(x0 + x, y0 + y, c, c, c);
    }
}

const videoPath = path.join(outDir, 'synthetic.mp4');
const ff = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', videoPath]);
const nFrames = Math.ceil(tEnd / (1000 / FPS));
let ri = -1;
(async () => {
  for (let f = 0; f < nFrames; f++) {
    const ms = f * 1000 / FPS;
    const img = Buffer.alloc(W * H * 3, 60);
    const lp = packetAt(ms - 1000 / FPS);
    drawBoard(img, 20, 30, 280, lp ? makePacket(N, lp.seq, 0, lp.epoch) : new Array(N).fill(0), 1, f);
    while (ri + 1 < remoteEvents.length && remoteEvents[ri + 1].time <= ms) ri++;
    drawBoard(img, 340, 30, 280, ri >= 0 ? remoteEvents[ri].bytes : new Array(N).fill(0), 0, 0);
    if (!ff.stdin.write(img)) await new Promise(r => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  ff.on('close', () => {
    console.log('video written, decoding...');
    const dec = spawnSync(process.execPath, [path.join(__dirname, 'decode-video.js'), videoPath], { encoding: 'utf8' });
    console.log(dec.stdout.trim().split('\n').slice(-1)[0]);
    const an = spawnSync(process.execPath, [path.join(__dirname, 'analyze.js'), videoPath.replace('.mp4', '.decoded.csv'), logPath], { encoding: 'utf8' });
    console.log(an.stdout);
    for (const r of runs) {
      const core = log.filter(l => l.epoch === r.epoch).filter((l, i, a) => l.sendStartMs <= a[a.length - 1].sendStartMs - 2000);
      const lost = core.filter(l => !truthRemote.has(`${l.epoch}:${l.seq}`)).length;
      console.log(`ground truth epoch ${r.epoch}: remote loss ${(100 * lost / core.length).toFixed(1)}% (${lost}/${core.length})`);
    }
  });
})();
