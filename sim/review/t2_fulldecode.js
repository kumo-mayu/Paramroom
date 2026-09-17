// For each codec/B/cfg: decode ALL units, compare decoder state with the encoder's quantized stream.
const path = require('path');
const I = require('../lib/image'); const M = require('../lib/metrics'); const T = require('../lib/transport');
const { loadCodec, padBits } = require('../lib/evaluate');
const PC = require('../codecs/packet-coder');
const W = require('../codecs/wav')._internal;
const C = require('../codecs/dct-common');
const img = process.argv[2] || 'kodim23';
const ref = I.loadPNG(path.join(__dirname, '..', 'images', 'ref', img + '.png'));
for (const B of [256, 32]) {
  const P = B - T.EPOCH_BITS;
  for (const name of ['wav', 'wavs', 'dctv']) {
    const codec = loadCodec(name);
    for (const cfg of codec.configs(B)) {
      if (cfg.rd) continue;
      const enc = codec.encode(ref, cfg, P);
      let q, layout, qd;
      if (name === 'dctv') {
        const lay = C.makeLayout(cfg); lay.denseEnd = lay.dcEndPos; layout = lay;
        q = C.quantizeImage(ref, lay);
        const tab = PC.train(lay, require('../codecs/training').trainingImages().map(im => C.quantizeImage(im, lay)));
        qd = new Int32Array(lay.total); enc.units.forEach(u => PC.apply(lay, tab, qd, padBits(u, P)));
      } else {
        const s = W.setup(cfg); layout = s.layout; q = W.quantize(ref, layout, cfg);
        if (name === 'wav') { qd = new Int32Array(layout.total); enc.units.forEach(u => PC.apply(layout, s.tab, qd, padBits(u, P), cfg)); }
      }
      let mism = -1, nzLost = 0, magLost = 0;
      if (qd) { mism = 0; for (let i = 0; i < q.length; i++) if (q[i] !== qd[i]) { mism++; if (qd[i] === 0) { nzLost++; magLost += Math.abs(q[i]); } } }
      const dec = codec.decoder(cfg, P); enc.units.forEach(u => dec.apply(padBits(u, P)));
      const m = M.all(ref, dec.render());
      let maxq = 0; for (const v of q) maxq = Math.max(maxq, Math.abs(v));
      console.log(`B=${B} ${name} ${cfg.label} units=${enc.units.length} kbit=${(enc.units.length*B/1000).toFixed(0)} mismatch=${mism} droppedNZ=${nzLost} max|q|=${maxq} full psnr=${m.psnr.toFixed(2)}`);
    }
  }
}
