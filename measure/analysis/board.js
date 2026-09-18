'use strict';
// Detect and decode Paramroom measurement boards in an RGB frame.
// Board = magenta frame (cyan segment at its top-left corner) around an 8 x 12 cell grid (see MeasureBoard shader).
// Boards may be seen in perspective and mirrored (e.g. the wearer looking at their own board from behind):
// the four outer corners of the magenta frame define a homography from board (u,v) to image pixels.
// Assumption: the board is roughly upright in the image (its top edge is above its bottom edge).

const FRAME_W = 0.04;

function isMagenta(r, g, b) { return r > 140 && b > 140 && g < 0.55 * Math.min(r, b); }
function isCyan(r, g, b) { return g > 140 && b > 140 && r < 0.55 * Math.min(g, b); }

// Solve homography H mapping (u,v) unit-square corners -> image points. src/dst: [[x,y] x4]
function homography(src, dst) {
  const A = [], bvec = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); bvec.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); bvec.push(Y);
  }
  // Gaussian elimination
  const n = 8, M = A.map((row, i) => [...row, bvec[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const h = M.map((row, i) => row[n] / row[i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}
function project(H, u, v) {
  const w = H[6] * u + H[7] * v + H[8];
  return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w];
}

// Find boards: connected components of magenta/cyan pixels (subsampled), keep large ones with a cyan part.
function detectBoards(frame, W, H, { step = 2, minSize = 40 } = {}) {
  const gw = Math.floor(W / step), gh = Math.floor(H / step);
  const mask = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      const o = (y * step * W + x * step) * 3;
      const r = frame[o], g = frame[o + 1], b = frame[o + 2];
      if (isMagenta(r, g, b)) mask[y * gw + x] = 1;
      else if (isCyan(r, g, b)) mask[y * gw + x] = 2;
    }
  const seen = new Uint8Array(gw * gh);
  const boards = [];
  const stack = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    // extreme points for corners
    let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity;
    let pSMin, pSMax, pDMin, pDMax, cyanX = 0, cyanY = 0, cyanN = 0, n = 0, x0 = gw, x1 = 0, y0 = gh, y1 = 0;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), x = j % gw, y = (j / gw) | 0;
      n++;
      if (mask[j] === 2) { cyanX += x; cyanY += y; cyanN++; }
      const s = x + y, d = x - y;
      if (s < sMin) { sMin = s; pSMin = [x, y]; }
      if (s > sMax) { sMax = s; pSMax = [x, y]; }
      if (d < dMin) { dMin = d; pDMin = [x, y]; }
      if (d > dMax) { dMax = d; pDMax = [x, y]; }
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const k = ny * gw + nx;
          if (mask[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
        }
    }
    if ((x1 - x0) * step < minSize || (y1 - y0) * step < minSize || cyanN < 3) continue;
    const sc = p => [(p[0] + 0.5) * step, (p[1] + 0.5) * step];
    const imgTL = sc(pSMin), imgBR = sc(pSMax), imgTR = sc(pDMax), imgBL = sc(pDMin);
    const cyan = [(cyanX / cyanN + 0.5) * step, (cyanY / cyanN + 0.5) * step];
    const dist = p => Math.hypot(p[0] - cyan[0], p[1] - cyan[1]);
    const corners = { TL: imgTL, TR: imgTR, BR: imgBR, BL: imgBL };
    const nearest = Object.keys(corners).reduce((a, k) => (dist(corners[k]) < dist(corners[a]) ? k : a), 'TL');
    // board corners in (u, vTop) space: (0,0)=board TL, (1,0)=TR, (1,1)=BR, (0,1)=BL
    let dst;
    const mirrorX = nearest === 'TR' || nearest === 'BR';
    const flipY = nearest === 'BL' || nearest === 'BR';
    if (!mirrorX && !flipY) dst = [imgTL, imgTR, imgBR, imgBL];
    else if (mirrorX && !flipY) dst = [imgTR, imgTL, imgBL, imgBR];
    else if (!mirrorX && flipY) dst = [imgBL, imgBR, imgTR, imgTL];
    else dst = [imgBR, imgBL, imgTL, imgTR];
    const Hm = homography([[0, 0], [1, 0], [1, 1], [0, 1]], dst);
    if (!Hm) continue;
    boards.push({ H: Hm, x: x0 * step, y: y0 * step, w: (x1 - x0 + 1) * step, h: (y1 - y0 + 1) * step, mirrorX, flipY, pixels: n });
  }
  boards.sort((a, b) => a.x - b.x);
  return boards;
}

// Sample cell (col,row) centre in board space via the homography.
function cellBit(frame, W, board, col, row, Himg) {
  const u = FRAME_W + (1 - 2 * FRAME_W) * ((col + 0.5) / 8);
  const v = FRAME_W + (1 - 2 * FRAME_W) * ((row + 0.5) / 12);
  const [fx, fy] = project(board.H, u, v);
  const px = Math.round(fx), py = Math.round(fy);
  let sum = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const X = px + dx, Y = py + dy;
      if (X < 0 || Y < 0 || X >= W || (Himg && Y >= Himg)) continue;
      const o = (Y * W + X) * 3;
      sum += frame[o] + frame[o + 1] + frame[o + 2];
      n++;
    }
  return n && sum / (n * 3) > 110 ? 1 : 0;
}

function decodeBoard(frame, W, board, Himg) {
  const bit = (c, r) => cellBit(frame, W, board, c, r, Himg);
  const bits = row => { let v = 0; for (let c = 0; c < 8; c++) v = (v << 1) | bit(c, row); return v; };
  const seq = (bits(0) << 8) | bits(1);
  const mode = bits(2);
  const flags = [0, 1, 2, 3, 4, 5, 6, 7].map(c => bit(c, 3));
  let mismatches = 0;
  for (let r = 4; r <= 7; r++) for (let c = 0; c < 8; c++) mismatches += bit(c, r);
  const loop = (bits(8) << 16) | (bits(9) << 8) | bits(10);
  const epoch = bits(11);
  return {
    seq, mode, epoch, loop, mismatches,
    consistent: flags[0], exact: flags[1], isLocal: flags[2], isFriend: flags[3], epochNonzero: flags[4], allZero: flags[5],
    // fixed cells: flag 6 always 0, flag 7 always 1, mismatch map cells 28..31 always 0
    valid: flags[6] === 0 && flags[7] === 1 && bit(4, 7) === 0 && bit(5, 7) === 0 && bit(6, 7) === 0 && bit(7, 7) === 0,
  };
}

module.exports = { detectBoards, decodeBoard, cellBit, FRAME_W };
