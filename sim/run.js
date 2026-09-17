'use strict';
// Parallel evaluation runner.
// Stage 1 (config selection on training images):
//   node run.js --grid select --imagedir ref-train --codecs pal,dctf,dctv,wav,wavs,prim --out results/select.jsonl
// Stage 2 (robustness on test images, selected configs):
//   node run.js --grid full --imagedir ref --selected results/selected.json --crc 0,8 --out results/full.jsonl
// Options: --budgets 256,64  --images a,b  --cfg regex  --workers N  --append
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort } = require('worker_threads');

if (!isMainThread) {
  const { evaluateTask } = require('./lib/evaluate');
  parentPort.on('message', task => {
    try {
      parentPort.postMessage({ ok: true, task, ...evaluateTask(task) });
    } catch (e) {
      parentPort.postMessage({ ok: false, task, error: e.stack });
    }
  });
  return;
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
    else { args[a.slice(2)] = next; i++; }
  }
}
const { loadCodec } = require('./lib/evaluate');
const gridName = args.grid || 'full';
const imageDir = args.imagedir || 'ref';
const budgets = (args.budgets || '256,128,64,32').split(',').map(Number);
const crcs = (args.crc || '0').split(',').map(Number);
const allImages = fs.readdirSync(path.join(__dirname, 'images', imageDir)).map(f => f.replace('.png', ''));
const images = args.images ? args.images.split(',') : allImages;
const out = args.out || `results/${gridName}.jsonl`;
const nWorkers = Number(args.workers || Math.max(1, os.cpus().length - 2));
const cfgFilter = args.cfg ? new RegExp(args.cfg) : null;
const cfgExclude = args.exclude ? new RegExp(args.exclude) : null;

// (codec, B, cfg) combos
const combos = [];
if (args.selected) {
  const sel = JSON.parse(fs.readFileSync(args.selected, 'utf8'));
  for (const s of sel) {
    if (!budgets.includes(s.B)) continue;
    const cfg = loadCodec(s.codec).configs(s.B).find(c => c.label === s.cfg);
    if (!cfg) throw new Error(`selected cfg not found: ${JSON.stringify(s)}`);
    combos.push({ codec: s.codec, B: s.B, cfg });
  }
} else {
  for (const codec of (args.codecs || 'pal,dctf,dctv,wav,wavs,prim').split(',')) {
    const mod = loadCodec(codec);
    for (const B of budgets) for (const cfg of mod.configs(B)) if ((!cfgFilter || cfgFilter.test(cfg.label)) && !(cfgExclude && cfgExclude.test(cfg.label))) combos.push({ codec, B, cfg });
  }
}
const tasks = [];
for (const c of combos) for (const crc of crcs) for (const image of images) tasks.push({ ...c, crcBits: crc, image, grid: gridName, imageDir });
// expensive codecs first so they spread over workers
tasks.sort((a, b) => (b.codec === 'prim') - (a.codec === 'prim'));

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const stream = fs.createWriteStream(out, { flags: args.append ? 'a' : 'w' });
const meta = fs.createWriteStream(out.replace(/\.jsonl$/, '') + '.meta.jsonl', { flags: args.append ? 'a' : 'w' });
console.log(`${tasks.length} tasks, ${nWorkers} workers`);
let next = 0, done = 0, failed = 0;
const start = Date.now();
for (let w = 0; w < Math.min(nWorkers, tasks.length); w++) {
  const worker = new Worker(__filename);
  const feed = () => { if (next < tasks.length) worker.postMessage(tasks[next++]); else worker.terminate(); };
  worker.on('message', msg => {
    done++;
    const t = msg.task;
    if (!msg.ok) { failed++; console.error('FAIL', t.codec, t.cfg.label, t.B, t.image, msg.error); }
    else {
      for (const r of msg.rows) stream.write(JSON.stringify(r) + '\n');
      meta.write(JSON.stringify({ codec: t.codec, cfg: t.cfg.label, B: t.B, crc: t.crcBits, image: t.image, encMs: msg.encMs, totalUnits: msg.totalUnits, baseCount: msg.baseCount, tornSeen: msg.tornSeen, tornAccepted: msg.tornAccepted }) + '\n');
    }
    if (done % 20 === 0 || done === tasks.length) console.log(`${done}/${tasks.length} (${((Date.now() - start) / 1000).toFixed(0)}s, failed ${failed})`);
    if (done === tasks.length) { stream.end(); meta.end(); }
    feed();
  });
  worker.on('error', e => console.error('worker error', e));
  feed();
}
