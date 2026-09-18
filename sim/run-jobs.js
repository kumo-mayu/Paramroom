'use strict';
// Runs a list of jobs with a fixed number of workers. Used to spread encodes over this machine and the second PC
// (see sim/remote.sh), and works the same on both because it only needs node.
//   node run-jobs.js <workers> <jobs file>      one job per line, e.g. "shape-eval.js encode kodim23 rf"
//   ... | node run-jobs.js <workers> -          jobs on stdin
const { spawn } = require('child_process');
const fs = require('fs');

const workers = Number(process.argv[2] || 8);
const src = process.argv[3] || '-';
const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
const jobs = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

let next = 0, done = 0, failed = 0;
const t0 = Date.now();
const runOne = () => {
  if (next >= jobs.length) return Promise.resolve();
  const job = jobs[next++];
  return new Promise(resolve => {
    const p = spawn(process.execPath, job.split(/\s+/), { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => {
      done++;
      if (code !== 0) failed++;
      const tag = code === 0 ? 'ok  ' : 'FAIL';
      console.log(`[${done}/${jobs.length} ${((Date.now() - t0) / 1000).toFixed(0)}s] ${tag} ${job}${code === 0 ? '' : '\n' + out.trim()}`);
      resolve();
    });
  }).then(runOne);
};

Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, runOne)).then(() => {
  console.log(`== all done: ${done - failed} ok, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(failed ? 1 : 0);
});
