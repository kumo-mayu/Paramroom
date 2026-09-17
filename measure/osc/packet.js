'use strict';
// Measurement packet definition (must match Assets/ImagePadMeasure/Shaders/ImagePadMeasureBoard.shader).
//   byte 0-1 : sequence number (big endian, 16 bit)
//   byte 2   : mode (0 = hash payload, 1 = sweep payload)
//   byte 3   : epoch = test-run label (1..255, never 0)
//   byte 4.. : payload, expectedByte(mode, seq, j)

function expectedByte(mode, seq, j) {
  if (mode === 1) return (seq + j * 37) & 255;
  let h = (Math.imul(seq, 2654435761) ^ Math.imul(j, 2246822519)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 739982445) >>> 0;
  h = (h ^ (h >>> 12)) >>> 0;
  h = Math.imul(h, 695872825) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h & 255;
}

function makePacket(nBytes, seq, mode, epoch) {
  const b = new Array(nBytes);
  b[0] = (seq >> 8) & 255;
  b[1] = seq & 255;
  b[2] = mode & 255;
  b[3] = epoch & 255;
  for (let j = 4; j < nBytes; j++) b[j] = expectedByte(mode, seq, j);
  return b;
}

function checkPacket(bytes, nBytes) {
  const seq = (bytes[0] << 8) | bytes[1], mode = bytes[2];
  let mismatches = 0;
  for (let j = 4; j < nBytes; j++) if (bytes[j] !== expectedByte(mode, seq, j)) mismatches++;
  return { seq, mode, epoch: bytes[3], consistent: mismatches === 0, mismatches };
}

module.exports = { expectedByte, makePacket, checkPacket };
