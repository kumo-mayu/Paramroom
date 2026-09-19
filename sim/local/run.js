'use strict';
// 全方式 × レート格子 × テスト画像を回して、ビット数と画質を JSONL に書く（docs/research/12）。
//   node local/run.js [--codecs a;b] [--images x,y] [--out local/results/rq.jsonl] [--threads 15]
// ワーカースレッドで並列に回す。結果は追記ではなく上書き。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (isMainThread) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
  const C = require('./common');
  const X = require('./codecs');
  const codecs = opt('codecs') ? opt('codecs').split(';') : Object.keys(X.CODECS); // 方式名にカンマを含むので ; で区切る
  const images = opt('images') ? opt('images').split(',') : C.SET.map(([n]) => n);
  const out = path.resolve(opt('out', path.join(__dirname, 'results', 'rq.jsonl')));
  const threads = Number(opt('threads', Math.max(1, os.cpus().length - 1)));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const jobs = [];
  for (const c of codecs) {
    if (!X.CODECS[c]) throw new Error('unknown codec ' + c);
    X.CODECS[c].grid.forEach((p, pi) => images.forEach(im => jobs.push({ c, pi, im })));
  }
  // 重いもの（VQ・パレット 256）を先に配る
  const weight = j => (j.c.startsWith('vq') ? 10 : j.c.startsWith('pal') ? 3 : 1);
  jobs.sort((a, b) => weight(b) - weight(a));
  console.log(`${jobs.length} jobs on ${threads} threads -> ${out}`);
  const ws = fs.createWriteStream(out);
  let next = 0, done = 0;
  const t0 = Date.now();
  let alive = threads;
  for (let t = 0; t < threads; t++) {
    const w = new Worker(__filename, { workerData: {} });
    const feed = () => { if (next < jobs.length) w.postMessage(jobs[next++]); else { w.postMessage(null); } };
    w.on('message', r => {
      ws.write(JSON.stringify(r) + '\n');
      done++;
      if (done % 50 === 0 || done === jobs.length) process.stdout.write(`\r${done}/${jobs.length} ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      feed();
    });
    w.on('error', e => { console.error('\nworker error', e); });
    w.on('exit', () => { if (--alive === 0) { ws.end(); console.log('\ndone'); } });
    feed();
  }
} else {
  const C = require('./common');
  const X = require('./codecs');
  const cache = new Map();
  parentPort.on('message', job => {
    if (!job) { process.exit(0); }
    const { c, pi, im } = job;
    if (!cache.has(im)) cache.set(im, C.loadSet([im])[0]);
    const e = cache.get(im);
    const p = X.CODECS[c].grid[pi];
    let res;
    try {
      const r = X.run(c, p, e.img);
      const q = C.evaluate(e, r.rec);
      res = { codec: c, fam: X.CODECS[c].fam, pi, p, image: im, kind: e.kind, w: e.img.w, h: e.img.h, bits: r.bits, bpp: r.bits / (e.img.w * e.img.h), ms: r.ms, ...q };
    } catch (err) {
      res = { codec: c, pi, p, image: im, error: String(err && err.stack || err) };
    }
    parentPort.postMessage(res);
  });
}
