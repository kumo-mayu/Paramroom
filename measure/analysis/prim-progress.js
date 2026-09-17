'use strict';
// Track decoded-image progression of the prim decoder display in a recording.
// Rectifies a quad (TL,TR,BR,BL) every 1/fps s, computes MS-SSIM (YCbCr 6:1:1) against
// (a) a reference PNG (e.g. JS render) and (b) the last rectified frame (in-game steady state).
// usage: node prim-progress.js <video> --corners x0,y0,...,y3 --ref ref.png [--fps 2] [--t0 0] [--t1 1e9] [--out out.csv] [--frames dir]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('ffmpeg-static');
const I = require('../../sim/lib/image');
const M = require('../../sim/lib/metrics');

const argv = process.argv.slice(2);
const video = argv[0];
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const c = opt('corners').split(',').map(Number);
const fps = Number(opt('fps', 2)), t0 = Number(opt('t0', 0)), t1 = Number(opt('t1', 1e9));
const ref = I.loadPNG(path.resolve(opt('ref')));
const out = opt('out', 'prim-progress.csv');
const framesDir = opt('frames', null);
if (framesDir) fs.mkdirSync(framesDir, { recursive: true });
const W = 1920, Hh = 1080, FS = W * Hh * 3;

function homography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X, X]);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]);
  }
  for (let col = 0; col < 8; col++) {
    let p = col; for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[p][col])) p = r;
    [A[col], A[p]] = [A[p], A[col]];
    for (let r = 0; r < 8; r++) { if (r === col) continue; const f = A[r][col] / A[col][col]; for (let k = col; k <= 8; k++) A[r][k] -= f * A[col][k]; }
  }
  return [...A.map((row, i) => row[8] / row[i]), 1];
}
const H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], [[c[0], c[1]], [c[2], c[3]], [c[4], c[5]], [c[6], c[7]]]);
function rectify(f) {
  const img = I.create(256, 256, 3);
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const u = (x + 0.5) / 256, v = (y + 0.5) / 256, w = H[6] * u + H[7] * v + H[8];
      const X = (H[0] * u + H[1] * v + H[2]) / w, Y = (H[3] * u + H[4] * v + H[5]) / w;
      const x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0;
      for (let k = 0; k < 3; k++) {
        const s = (xx, yy) => f[(yy * W + xx) * 3 + k];
        img.data[(y * 256 + x) * 3 + k] = (s(x0, y0) * (1 - fx) + s(x0 + 1, y0) * fx) * (1 - fy) + (s(x0, y0 + 1) * (1 - fx) + s(x0 + 1, y0 + 1) * fx) * fy;
      }
    }
  return img;
}

const frames = [];
const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(t0), '-i', video];
if (t1 < 1e9) args.push('-t', String(t1 - t0));
args.push('-vf', `fps=${fps}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
const p = spawn(ffmpeg, args);
const buf = Buffer.alloc(FS); let fill = 0;
p.stdout.on('data', chunk => {
  let off = 0;
  while (off < chunk.length) {
    const n = Math.min(FS - fill, chunk.length - off);
    chunk.copy(buf, fill, off, off + n); fill += n; off += n;
    if (fill === FS) { frames.push({ t: t0 + frames.length / fps, img: rectify(buf) }); fill = 0; }
  }
});
p.on('close', () => {
  const last = frames[frames.length - 1].img;
  const lines = ['t,msssimc_ref,psnr_ref,msssimc_last,psnr_last,meanY'];
  for (const fr of frames) {
    const a = M.all(ref, fr.img), b = M.all(last, fr.img);
    let s = 0; for (let i = 0; i < fr.img.data.length; i += 3) s += 0.299 * fr.img.data[i] + 0.587 * fr.img.data[i + 1] + 0.114 * fr.img.data[i + 2];
    lines.push([fr.t.toFixed(2), a.msssimc.toFixed(4), a.psnr.toFixed(2), b.msssimc.toFixed(4), b.psnr.toFixed(2), (s / 65536).toFixed(1)].join(','));
    if (framesDir && Math.abs(fr.t * 2 - Math.round(fr.t * 2)) < 1e-6 && Math.round(fr.t * 2) % 2 === 0) I.savePNG(I.clamp255(fr.img), path.join(framesDir, `t${fr.t.toFixed(0)}.png`));
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`${frames.length} frames -> ${out}`);
});
