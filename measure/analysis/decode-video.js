'use strict';
// Decode every frame of a screen recording containing ImagePad measurement boards.
// usage: node decode-video.js <video> [--out decoded.csv] [--redetect 15]
// Output CSV: frame,timeMs,boardIdx,x,y,w,h,seq,mode,epoch,consistent,exact,isLocal,isFriend,allZero,mismatches,loop,valid
// Timestamps assume a constant frame rate (record with OBS at a fixed FPS, CFR).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const ffmpeg = require('ffmpeg-static');
const B = require('./board');

const argv = process.argv.slice(2);
const video = argv[0];
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
if (!video) { console.log('usage: node decode-video.js <video> [--out decoded.csv] [--redetect 15]'); process.exit(1); }
const out = opt('out', video.replace(/\.[^.]+$/, '') + '.decoded.csv');
const redetect = Number(opt('redetect', 15));

const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', video], { encoding: 'utf8' }).stderr;
const m = probe.match(/Video:.*?(\d{2,5})x(\d{2,5}).*?([\d.]+) fps/);
if (!m) { console.error('could not read video size/fps:\n' + probe); process.exit(1); }
const W = +m[1], H = +m[2], fps = +m[3];
console.log(`video ${W}x${H} @ ${fps} fps`);

const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', video, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-vsync', '0', '-']);
const csv = fs.createWriteStream(out);
csv.write('frame,timeMs,boardIdx,x,y,w,h,seq,mode,epoch,consistent,exact,isLocal,isFriend,allZero,mismatches,loop,valid\n');
const frameSize = W * H * 3;
let buf = Buffer.alloc(0), frame = 0, boards = [], lastLog = Date.now();
proc.stdout.on('data', chunk => {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  while (buf.length >= frameSize) {
    const f = buf.subarray(0, frameSize);
    if (frame % redetect === 0 || boards.length === 0) boards = B.detectBoards(f, W, H);
    boards.forEach((b, i) => {
      const d = B.decodeBoard(f, W, b, H);
      csv.write(`${frame},${(frame * 1000 / fps).toFixed(2)},${i},${b.x},${b.y},${b.w},${b.h},${d.seq},${d.mode},${d.epoch},${d.consistent},${d.exact},${d.isLocal},${d.isFriend},${d.allZero},${d.mismatches},${d.loop},${d.valid ? 1 : 0}\n`);
    });
    buf = buf.subarray(frameSize);
    frame++;
    if (Date.now() - lastLog > 5000) { console.log(`frame ${frame} (${(frame / fps).toFixed(0)} s), boards ${boards.length}`); lastLog = Date.now(); }
  }
});
proc.on('close', code => { csv.end(); console.log(`done: ${frame} frames -> ${out} (ffmpeg exit ${code})`); });
