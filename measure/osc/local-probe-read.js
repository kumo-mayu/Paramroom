'use strict';
// Read the local transport probe's overlay (ParamroomLocalHud.shader) from a screenshot of VRChat (docs/research/12).
//   node local-probe-read.js [shot.png] [--image]   # without a file: captures the VRChat window (capture-window.ps1)
// Prints the 16 control words and what follows from them (completion time, fps, torn frames).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require(path.join(__dirname, '..', 'analysis', 'node_modules', 'pngjs'));

// word order of the control row: the probe (ParamroomLocalLoop.shader) or, with --image, the local image prefab
// (ParamroomLocalImageLoop.shader)
const IMAGE = process.argv.includes('--image');
const NAMES = IMAGE
  ? ['frames', 'present', 'total', 'taken', 'rejected', 'nowMs', 'firstMs', 'completeMs', 'completeFrame', 'session', 'size',
    'decodedMs', 'longestFrameUs', 'resetMs', 'cleanFrames', 'tornFrames']
  : ['frames', 'present', 'correct', 'taken', 'rejected', 'nowMs', 'firstMs', 'completeMs', 'framesAtComplete',
    'session', 'target', 'framesWithTaken', 'longestFrameUs', 'resetMs', 'cleanFrames', 'tornFrames'];

function capture() {
  const out = path.join(require('os').tmpdir(), `paramroom-probe-${Date.now()}.png`);
  execFileSync('pwsh', ['-NoProfile', '-File', path.join(__dirname, 'capture-window.ps1'), '-Out', out], { stdio: 'pipe' });
  return out;
}

function read(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const { width: W, height: H, data } = png;
  const lum = (x, y) => { const i = (Math.round(y) * W + Math.round(x)) * 4; return (data[i] + data[i + 1] + data[i + 2]) / 3; };
  // overlay rectangle: clip x -0.95..-0.15, y -0.95..0.95; statistics = top half, 34 x 18 cells
  const x0 = (1 - 0.95) / 2 * W, x1 = (1 - 0.15) / 2 * W, yTop = (1 - 0.95) / 2 * H, yMid = yTop + (0.95 * H) / 2;
  const cw = (x1 - x0) / 34, ch = (yMid - yTop) / 18;
  const bit = (cx, cy) => lum(x0 + (cx + 0.5) * cw, yTop + (cy + 0.5) * ch) > 127 ? 1 : 0;
  // frame check: top/bottom rows alternate starting white, left/right columns white
  let frameErr = 0;
  for (let cx = 0; cx < 34; cx++) { frameErr += bit(cx, 0) !== ((cx & 1) ? 0 : 1); frameErr += bit(cx, 17) !== ((cx & 1) ? 0 : 1); }
  for (let cy = 1; cy < 17; cy++) { frameErr += bit(0, cy) !== 1; frameErr += bit(33, cy) !== 1; }
  const words = [];
  for (let r = 0; r < 16; r++) {
    let w = 0;
    for (let b = 0; b < 32; b++) w = (w * 2) + bit(1 + b, 1 + r);
    words.push(w);
  }
  const s = Object.fromEntries(NAMES.map((n, i) => [n, words[i]]));
  const since = s.nowMs - s.resetMs;
  const derived = {
    frameErrors: frameErr,
    shot: `${W}x${H}`,
    fpsSinceReset: since > 0 ? +(s.frames / since * 1000).toFixed(2) : null,
    completeAfterFirstMs: s.completeMs ? s.completeMs - s.firstMs : null,
    completeAfterResetMs: s.completeMs ? s.completeMs - s.resetMs : null,
    rejectedShare: s.taken + s.rejected ? +(s.rejected / (s.taken + s.rejected)).toFixed(4) : null,
    tornFrameShare: s.framesWithTaken ? +(s.tornFrames / s.framesWithTaken).toFixed(4) : null,
    ...(IMAGE ? { width: s.size >>> 16, height: s.size & 0xFFFF, decodeAfterCompleteMs: s.decodedMs && s.completeMs ? s.decodedMs - s.completeMs : null } : {}),
  };
  return { ...s, ...derived };
}

const file = process.argv.slice(2).find(a => !a.startsWith('--')) || capture();
console.log(JSON.stringify(read(file), null, 1));
