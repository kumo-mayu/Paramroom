'use strict';
// Paramroom measurement OSC sender (no dependencies).
// Writes Int parameters /avatar/parameters/D0..D(n-1) to VRChat (default 127.0.0.1:9000) and logs every send.
//
// usage:
//   node sender.js zero                                  # all parameters 0 (board shows allZero)
//   node sender.js exact  [--bytes 32] [--hold 500] [--count 120]            # value exactness (hash + sweep)
//   node sender.js hold   [--bytes 32] [--holds 80,100,117,133,150,200,300,500] [--count 150]
//                         [--bundle] [--order forward|reverse|shuffle] [--msgDelay 0]
//   node sender.js idle   [--bytes 32] [--hold 300]      # continuous traffic for late-join / culling tests (Ctrl+C)
//   common: [--host 127.0.0.1] [--port 9000] [--epoch 1] [--listen 9001]
// Logs: measure/logs/<time>-<command>.csv  (seq, mode, epoch, holdMs, sendStartMs, sendEndMs, unixMs)
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { makePacket } = require('./packet');

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
const nBytes = Number(opt('bytes', 32));
const sock = dgram.createSocket('udp4');

// ---- minimal OSC encoding
function oscString(s) {
  const b = Buffer.from(s + '\0', 'ascii');
  const pad = (4 - (b.length % 4)) % 4;
  return Buffer.concat([b, Buffer.alloc(pad)]);
}
function oscInt(address, value) {
  const v = Buffer.alloc(4);
  v.writeInt32BE(value | 0);
  return Buffer.concat([oscString(address), oscString(',i'), v]);
}
function oscBundle(messages) {
  const parts = [oscString('#bundle'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]; // timetag: immediately
  for (const m of messages) { const len = Buffer.alloc(4); len.writeInt32BE(m.length); parts.push(len, m); }
  return Buffer.concat(parts);
}
const send = buf => new Promise((res, rej) => sock.send(buf, port, host, e => (e ? rej(e) : res())));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendPacket(bytes, { bundle = false, order = 'forward', msgDelay = 0 } = {}) {
  let idx = bytes.map((_, i) => i);
  if (order === 'reverse') idx.reverse();
  if (order === 'shuffle') idx.sort(() => Math.random() - 0.5);
  const msgs = idx.map(i => oscInt(`/avatar/parameters/D${i}`, bytes[i]));
  if (bundle) { await send(oscBundle(msgs)); return; }
  for (const m of msgs) {
    await send(m);
    if (msgDelay > 0) await sleep(msgDelay);
  }
}

// ---- logging
const logDir = path.join(__dirname, '..', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(logDir, `${stamp}-${cmd}.csv`);
const log = fs.createWriteStream(logPath);
log.write('seq,mode,epoch,holdMs,sendStartMs,sendEndMs,unixMs,bundle,order,msgDelay\n');
const t0 = performance.now(), unix0 = Date.now();
const nowMs = () => performance.now() - t0;
console.log(`log: ${logPath}  (perf t0 = unix ${unix0})`);

// optional: listen for VRChat OSC output (avatar change) to timestamp avatar loads
if (opt('listen', false)) {
  const lport = Number(opt('listen', 9001));
  const rx = dgram.createSocket('udp4');
  const evlog = fs.createWriteStream(path.join(logDir, `${stamp}-${cmd}-oscin.csv`));
  evlog.write('ms,address\n');
  rx.on('message', m => {
    const addr = m.toString('ascii', 0, m.indexOf(0));
    if (addr === '/avatar/change') { evlog.write(`${nowMs().toFixed(1)},${addr}\n`); console.log('avatar change', nowMs().toFixed(0)); }
  });
  rx.bind(lport);
}

let seq = Number(opt('seq', 1));
const epoch = Math.max(1, Math.min(255, Number(opt('epoch', 1))));

// Send packets at fixed hold intervals with drift-free scheduling.
async function run(count, holdMs, mode, sendOpts, epochV = epoch) {
  let next = nowMs();
  for (let k = 0; k < count; k++) {
    const target = next;
    while (nowMs() < target - 2) await sleep(Math.max(0, target - nowMs() - 2));
    while (nowMs() < target) { /* spin the last 2 ms for timing accuracy */ }
    const s = nowMs();
    await sendPacket(makePacket(nBytes, seq, mode, epochV), sendOpts);
    const e = nowMs();
    log.write(`${seq},${mode},${epochV},${holdMs},${s.toFixed(2)},${e.toFixed(2)},${(unix0 + s).toFixed(1)},${sendOpts.bundle ? 1 : 0},${sendOpts.order || 'forward'},${sendOpts.msgDelay || 0}\n`);
    seq = (seq + 1) & 0xffff;
    if (seq === 0) seq = 1;
    next += holdMs;
  }
}

(async () => {
  const sendOpts = { bundle: !!opt('bundle', false), order: opt('order', 'forward'), msgDelay: Number(opt('msgDelay', 0)) };
  if (cmd === 'zero') {
    await sendPacket(new Array(nBytes).fill(0), sendOpts);
    console.log('sent all-zero packet');
  } else if (cmd === 'exact') {
    const hold = Number(opt('hold', 500)), count = Number(opt('count', 120));
    await run(count, hold, 0, sendOpts);
    await run(count, hold, 1, sendOpts);
  } else if (cmd === 'hold') {
    const holds = String(opt('holds', '80,100,117,133,150,200,300,500')).split(',').map(Number);
    const count = Number(opt('count', 150));
    for (let h = 0; h < holds.length; h++) {
      const ep = Math.min(255, epoch + h); // one epoch label per hold time
      console.log(`hold ${holds[h]} ms x ${count} (epoch ${ep})`);
      await run(count, holds[h], 0, sendOpts, ep);
      await run(Math.ceil(2000 / holds[h]), holds[h], 0, sendOpts, ep); // 2 s tail so the last packet is observable
    }
  } else if (cmd === 'idle') {
    const hold = Number(opt('hold', 300));
    console.log('sending continuously, Ctrl+C to stop');
    for (;;) await run(100, hold, 0, sendOpts);
  } else {
    console.log('commands: zero | exact | hold | idle   (see header of sender.js)');
  }
  log.end();
  sock.close();
  setTimeout(() => process.exit(0), 200);
})();
