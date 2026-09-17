'use strict';
// Extract frames of a recording at given times, rectify a quadrilateral region (4 corners TL,TR,BR,BL) to 256x256.
// usage: node rectify.js <video> --corners x0,y0,x1,y1,x2,y2,x3,y3 --times 1,2,5 --out dir [--mirror]
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('ffmpeg-static');
const { PNG } = require('pngjs');

const argv = process.argv.slice(2);
const video = argv[0];
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const c = opt('corners').split(',').map(Number);
const times = opt('times').split(',').map(Number);
const outDir = opt('out', 'rectified');
const mirror = argv.includes('--mirror');
fs.mkdirSync(outDir, { recursive: true });

function homography(src, dst) {
  const M = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    M.push([x, y, 1, 0, 0, 0, -x * X, -y * X, X]);
    M.push([0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]);
  }
  for (let col = 0; col < 8; col++) {
    let p = col; for (let r = col + 1; r < 8; r++) if (Math.abs(M[r][col]) > Math.abs(M[p][col])) p = r;
    [M[col], M[p]] = [M[p], M[col]];
    for (let r = 0; r < 8; r++) { if (r === col) continue; const f = M[r][col] / M[col][col]; for (let k = col; k <= 8; k++) M[r][k] -= f * M[col][k]; }
  }
  const h = M.map((row, i) => row[8] / row[i]);
  return [...h, 1];
}
const quad = [[c[0], c[1]], [c[2], c[3]], [c[4], c[5]], [c[6], c[7]]];
const unit = mirror ? [[1, 0], [0, 0], [0, 1], [1, 1]] : [[0, 0], [1, 0], [1, 1], [0, 1]];
const H = homography(unit, quad);

for (const t of times) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', video, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
  const W = 1920, f = r.stdout;
  const png = new PNG({ width: 256, height: 256 });
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const u = (x + 0.5) / 256, v = (y + 0.5) / 256;
      const w = H[6] * u + H[7] * v + H[8];
      const X = (H[0] * u + H[1] * v + H[2]) / w, Y = (H[3] * u + H[4] * v + H[5]) / w;
      const x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0;
      for (let k = 0; k < 3; k++) {
        const s = (xx, yy) => f[(yy * W + xx) * 3 + k];
        const val = (s(x0, y0) * (1 - fx) + s(x0 + 1, y0) * fx) * (1 - fy) + (s(x0, y0 + 1) * (1 - fx) + s(x0 + 1, y0 + 1) * fx) * fy;
        png.data[(y * 256 + x) * 4 + k] = Math.round(val);
      }
      png.data[(y * 256 + x) * 4 + 3] = 255;
    }
  fs.writeFileSync(path.join(outDir, `t${t}.png`), PNG.sync.write(png));
}
console.log(`wrote ${times.length} frames to ${outDir}`);
