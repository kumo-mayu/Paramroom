'use strict';
// Paramroom local transport probe - OSC sender (docs/research/12). No dependencies.
// Writes the probe avatar's LOCAL Float parameters PRL0..PRL{K-1} (not synced: nothing reaches other players).
//
//   node local-probe.js run   --k 512 [--groups 16] [--chunks 1024] [--rate 60] [--passes 2] [--maxbytes 1400]
//                             [--settle 500] [--tail 1000]
//   node local-probe.js hud 0|1          # the overlay on / off
//   node local-probe.js clear            # new session: clears the store and the statistics
//   common: [--host 127.0.0.1] [--port 9000] [--prefix PRL]
//
// One send = one value for each of the first 32 * groups parameters: group g carries one chunk
//   F0 = header [tag 2][0 12][chunk 16], F1..F31 = [tag 2][test pattern 28]   (float bits = 2^23 + value)
// tag = send counter mod 4 (the avatar drops groups whose parameters come from different sends).
// Chunks go round robin: pass 1 sends 0..chunks-1 once, pass 2 again, ... The avatar counts what it received;
// read it with local-probe-read.js. Every send is logged to measure/logs/<date>-local/<time>-local-run.csv.
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const host = opt('host', '127.0.0.1');
const port = Number(opt('port', 9000));
const prefix = opt('prefix', 'PRL');
const sock = dgram.createSocket('udp4');
const send = buf => new Promise((res, rej) => sock.send(buf, port, host, e => (e ? rej(e) : res())));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the probe's test pattern (ParamroomLocalGroup.shader Hash)
function hash(x) {
  x >>>= 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}
const enc = (tag, payload) => (((tag & 3) << 28 | (payload & 0x0FFFFFFF)) >>> 0) + 0x00800000;

// ---- OSC
function oscString(s) {
  const b = Buffer.from(s + '\0', 'ascii');
  return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
}
const FLOAT_TAG = oscString(',f');
function floatBitsMsg(addrBuf, bits) {
  const m = Buffer.alloc(addrBuf.length + 8);
  addrBuf.copy(m, 0); FLOAT_TAG.copy(m, addrBuf.length); m.writeUInt32BE(bits >>> 0, addrBuf.length + 4);
  return m;
}
function floatMsg(addr, v) {
  const a = oscString(addr), m = Buffer.alloc(a.length + 8);
  a.copy(m, 0); FLOAT_TAG.copy(m, a.length); m.writeFloatBE(v, a.length + 4);
  return m;
}
const BUNDLE_HEAD = Buffer.concat([oscString('#bundle'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]);
function bundle(msgs) {
  const parts = [BUNDLE_HEAD];
  for (const m of msgs) { const len = Buffer.alloc(4); len.writeInt32BE(m.length); parts.push(len, m); }
  return Buffer.concat(parts);
}
// split into datagrams of at most maxBytes, never splitting a group of 32 messages (unless one group alone is larger)
function datagrams(groupsMsgs, maxBytes) {
  const out = []; let cur = [], size = BUNDLE_HEAD.length;
  for (const gm of groupsMsgs) {
    const gsize = gm.reduce((s, m) => s + 4 + m.length, 0);
    if (cur.length && size + gsize > maxBytes) { out.push(bundle(cur)); cur = []; size = BUNDLE_HEAD.length; }
    if (gsize + BUNDLE_HEAD.length > maxBytes) {
      for (const m of gm) {
        if (cur.length && size + 4 + m.length > maxBytes) { out.push(bundle(cur)); cur = []; size = BUNDLE_HEAD.length; }
        cur.push(m); size += 4 + m.length;
      }
    } else { cur.push(...gm); size += gsize; }
  }
  if (cur.length) out.push(bundle(cur));
  return out;
}

async function setParam(name, v) { await send(floatMsg(`/avatar/parameters/${name}`, v)); }

async function run() {
  const K = Number(opt('k', 512));
  const groups = Number(opt('groups', K / 32));
  const chunks = Number(opt('chunks', 1024));
  const rate = Number(opt('rate', 60));
  const passes = Number(opt('passes', 2));
  const maxBytes = Number(opt('maxbytes', 1400));   // one group per datagram: VRChat drops datagrams over ~4 KB (measured 2026-09-19)
  const settle = Number(opt('settle', 500)), tail = Number(opt('tail', 1000));
  if (groups * 32 > K) throw new Error('groups * 32 > k');
  const session = 1 + Math.floor(Math.random() * 1e6);
  const addrs = Array.from({ length: groups * 32 }, (_, i) => oscString(`/avatar/parameters/${prefix}${i}`));

  await setParam('PRS', session);
  await setParam('PRT', chunks);
  await sleep(settle);

  const totalSends = Math.ceil(chunks * passes / groups);
  const period = 1000 / rate;
  const log = ['send,tStartMs,tEndMs,datagrams,bytes,firstChunk'];
  let bytesTotal = 0, dgTotal = 0, late = 0;
  const t0 = performance.now();
  for (let s = 0; s < totalSends; s++) {
    const due = t0 + s * period;
    let now = performance.now();
    if (now < due - 2) { await sleep(due - now - 2); }
    while (performance.now() < due) { /* spin the last ~2 ms */ }
    const tStart = performance.now();
    if (tStart - due > period / 2) late++;
    const tag = s & 3;
    const gm = [];
    let first = -1;
    for (let g = 0; g < groups; g++) {
      const c = (s * groups + g) % chunks;
      if (g === 0) first = c;
      const msgs = [floatBitsMsg(addrs[g * 32], enc(tag, c))];
      for (let j = 1; j < 32; j++) msgs.push(floatBitsMsg(addrs[g * 32 + j], enc(tag, hash(c * 32 + j))));
      gm.push(msgs);
    }
    const dgs = datagrams(gm, maxBytes);
    for (const d of dgs) { await send(d); bytesTotal += d.length; }
    dgTotal += dgs.length;
    log.push(`${s},${(tStart - t0).toFixed(3)},${(performance.now() - t0).toFixed(3)},${dgs.length},${dgs.reduce((a, d) => a + d.length, 0)},${first}`);
  }
  const elapsed = performance.now() - t0;
  // zero every parameter, so the last send is not taken again as the next session starts
  await sleep(100);
  for (let g = 0; g < groups; g++) await send(bundle(Array.from({ length: 32 }, (_, j) => floatBitsMsg(addrs[g * 32 + j], 0))));
  await sleep(tail);
  const dir = path.join(__dirname, '..', 'logs', new Date().toISOString().slice(0, 10) + '-local');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-local-run.csv`);
  fs.writeFileSync(file, `# session ${session} k ${K} groups ${groups} chunks ${chunks} rate ${rate} passes ${passes} maxbytes ${maxBytes}\n` + log.join('\n') + '\n');
  console.log(JSON.stringify({ session, k: K, groups, chunks, rate, passes, maxBytes, sends: totalSends,
    elapsedMs: Math.round(elapsed), datagrams: dgTotal, bytes: bytesTotal, kbitPerSecOnWire: Math.round(bytesTotal * 8 / elapsed),
    payloadKbitPerSec: Math.round(totalSends * groups * 868 / elapsed), lateSends: late, log: path.relative(process.cwd(), file) }));
}

// Load only, to split the frame cost of receiving OSC from the cost of what the values change:
//   --mode bogus  addresses the avatar does not have (parse + dispatch only)
//          same   the probe's parameters, the same values every time (no parameter changes)
//          change the probe's parameters, new values every time (as run)
async function flood() {
  const groups = Number(opt('groups', 16)), rate = Number(opt('rate', 60)), seconds = Number(opt('seconds', 12));
  const mode = opt('mode', 'bogus');
  const name = i => mode === 'bogus' ? `PRX${i}` : `${prefix}${i}`;
  const addrs = Array.from({ length: groups * 32 }, (_, i) => oscString(`/avatar/parameters/${name(i)}`));
  const period = 1000 / rate, t0 = performance.now();
  let s = 0;
  while (performance.now() - t0 < seconds * 1000) {
    const due = t0 + s * period;
    const now = performance.now();
    if (now < due - 2) await sleep(due - now - 2);
    while (performance.now() < due) { /* spin */ }
    const v = mode === 'change' ? s : 1;
    for (let g = 0; g < groups; g++)
      await send(bundle(Array.from({ length: 32 }, (_, j) => floatBitsMsg(addrs[g * 32 + j], enc(v & 3, (v * 7919 + g * 32 + j) & 0xFFFFFFF)))));
    s++;
  }
  if (mode !== 'bogus') for (let g = 0; g < groups; g++) await send(bundle(Array.from({ length: 32 }, (_, j) => floatBitsMsg(addrs[g * 32 + j], 0))));
  console.log(JSON.stringify({ mode, groups, rate, sends: s, msgsPerSec: Math.round(s * groups * 32 / seconds) }));
}

(async () => {
  try {
    if (cmd === 'run') await run();
    else if (cmd === 'flood') await flood();
    else if (cmd === 'avatar') {
      // switch to one of the user's probe avatars: /avatar/change <avtr_...>
      const a = oscString('/avatar/change'), t = oscString(',s'), v = oscString(argv[1]);
      await send(Buffer.concat([a, t, v]));
    }
    else if (cmd === 'hud') await setParam('PRH', Number(argv[1] ?? 1));
    else if (cmd === 'clear') { await setParam('PRS', 1 + Math.floor(Math.random() * 1e6)); await setParam('PRT', 0); }
    else { console.log('usage: node local-probe.js run|hud|clear ... (see the header)'); process.exitCode = 1; }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  sock.close();
})();
