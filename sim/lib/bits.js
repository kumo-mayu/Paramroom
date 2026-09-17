'use strict';
// Bit-level I/O. A packet payload is a plain array of 0/1 numbers (MSB-first fields).

class BitWriter {
  constructor() { this.bits = []; }
  get length() { return this.bits.length; }
  write(value, n) {
    for (let i = n - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  writeSigned(value, n) { // two's complement in n bits
    this.write(value & ((1 << n) - 1), n);
  }
  // unsigned Exp-Golomb of order k
  writeEG(value, k = 0) {
    const v = value + (1 << k);
    const len = 32 - Math.clz32(v);
    for (let i = 0; i < len - 1 - k; i++) this.bits.push(0);
    this.write(v, len);
  }
  static egLength(value, k = 0) {
    const v = value + (1 << k);
    const len = 32 - Math.clz32(v);
    return 2 * len - 1 - k;
  }
  writeSEG(value, k = 0) { // signed EG: 0,1,-1,2,-2...
    this.writeEG(value > 0 ? 2 * value - 1 : -2 * value, k);
  }
  static segLength(value, k = 0) {
    return BitWriter.egLength(value > 0 ? 2 * value - 1 : -2 * value, k);
  }
}

class BitReader {
  constructor(bits) { this.bits = bits; this.pos = 0; }
  get remaining() { return this.bits.length - this.pos; }
  read(n) {
    if (this.pos + n > this.bits.length) throw new RangeError('read past end');
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bits[this.pos++];
    return v >>> 0;
  }
  readSigned(n) {
    const v = this.read(n);
    return v >= (1 << (n - 1)) ? v - (1 << n) : v;
  }
  readEG(k = 0) {
    let zeros = 0;
    while (true) {
      if (this.pos >= this.bits.length) throw new RangeError('read past end');
      if (this.bits[this.pos] === 1) break;
      zeros++; this.pos++;
    }
    return this.read(zeros + 1 + k) - (1 << k);
  }
  readSEG(k = 0) {
    const u = this.readEG(k);
    return u & 1 ? (u + 1) >> 1 : -(u >> 1);
  }
}

module.exports = { BitWriter, BitReader };
