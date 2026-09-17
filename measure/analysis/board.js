'use strict';
// Detect and decode ImagePad measurement boards in an RGB frame.
// Board = magenta frame (cyan segment at its top-left corner) around an 8 x 12 cell grid (see MeasureBoard shader).

const FRAME_W = 0.04;

function isMagenta(r, g, b) { return r > 170 && g < 90 && b > 170; }
function isCyan(r, g, b) { return r < 90 && g > 170 && b > 170; }

// Find boards: connected components of magenta/cyan pixels (on a subsampled grid), keep large ones.
function detectBoards(frame, W, H, { step = 2, minSize = 60 } = {}) {
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
    let x0 = gw, y0 = gh, x1 = -1, y1 = -1, cyanX = 0, cyanY = 0, cyanN = 0, n = 0;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), x = j % gw, y = (j / gw) | 0;
      n++;
      if (mask[j] === 2) { cyanX += x; cyanY += y; cyanN++; }
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const k = ny * gw + nx;
        if (mask[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    const bw = (x1 - x0 + 1) * step, bh = (y1 - y0 + 1) * step;
    if (bw < minSize || bh < minSize || cyanN === 0) continue;
    // orientation: cyan centroid relative to box centre
    const cx = (cyanX / cyanN - x0) / (x1 - x0 + 1), cy = (cyanY / cyanN - y0) / (y1 - y0 + 1);
    boards.push({ x: x0 * step, y: y0 * step, w: bw, h: bh, mirrorX: cx > 0.5, mirrorY: cy > 0.5, pixels: n });
  }
  boards.sort((a, b) => a.x - b.x);
  return boards;
}

// Sample cell (col,row) centre in board-local normalised coordinates (unmirrored).
function cellBit(frame, W, board, col, row) {
  let u = FRAME_W + (1 - 2 * FRAME_W) * ((col + 0.5) / 8);
  let v = FRAME_W + (1 - 2 * FRAME_W) * ((row + 0.5) / 12); // v from top
  if (board.mirrorX) u = 1 - u;
  if (board.mirrorY) v = 1 - v;
  const px = Math.round(board.x + u * board.w), py = Math.round(board.y + v * board.h);
  let sum = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const o = ((py + dy) * W + (px + dx)) * 3;
      sum += frame[o] + frame[o + 1] + frame[o + 2];
      n++;
    }
  return sum / (n * 3) > 127 ? 1 : 0;
}

function decodeBoard(frame, W, board) {
  const bits = (row, from = 0, count = 8) => {
    let v = 0;
    for (let c = from; c < from + count; c++) v = (v << 1) | cellBit(frame, W, board, c, row);
    return v;
  };
  const seq = (bits(0) << 8) | bits(1);
  const mode = bits(2);
  const flags = [0, 1, 2, 3, 4, 5, 6, 7].map(c => cellBit(frame, W, board, c, 3));
  let mismatches = 0;
  for (let r = 4; r <= 7; r++) for (let c = 0; c < 8; c++) mismatches += cellBit(frame, W, board, c, r);
  const loop = (bits(8) << 16) | (bits(9) << 8) | bits(10);
  const epoch = bits(11);
  return {
    seq, mode, epoch, loop, mismatches,
    consistent: flags[0], exact: flags[1], isLocal: flags[2], isFriend: flags[3], epochNonzero: flags[4], allZero: flags[5],
    valid: flags[6] === 0 && flags[7] === 1, // fixed cells: decoding sanity check
  };
}

module.exports = { detectBoards, decodeBoard, cellBit, FRAME_W };
