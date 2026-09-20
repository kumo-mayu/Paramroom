'use strict';
// Listen to mDNS (224.0.0.251:5353) and log every OSC / OSCQuery announcement, to see who re-announces and on which
// port (docs/research/14). Receive only: no queries are sent, so nothing on the network is asked to do anything.
//   node mdns-watch.js [--seconds 180] [--filter Paramroom]
// Prints one line per SRV record: time, service name, host, port; and notes when a name appears on a new port.
const dgram = require('dgram');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const seconds = Number(opt('seconds', 180));
const filter = opt('filter', '');

// ---- minimal DNS parsing (only what mDNS packets need: names with compression, SRV/PTR/TXT/A)
function readName(buf, off) {
  const parts = [];
  let jumped = false, next = off, guard = 0;
  while (guard++ < 128) {
    const len = buf[off];
    if (len === undefined) break;
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[off + 1];
      if (!jumped) next = off + 2;
      jumped = true; off = ptr; continue;
    }
    if (len === 0) { if (!jumped) next = off + 1; break; }
    parts.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return [parts.join('.'), next];
}

function parse(buf) {
  const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)];
  let off = 12;
  for (let i = 0; i < counts[0]; i++) { off = readName(buf, off)[1] + 4; }
  const records = [];
  for (const [ri, n] of [counts[1], counts[2], counts[3]].entries())
    for (let i = 0; i < n; i++) {
      const [name, afterName] = readName(buf, off);
      const type = buf.readUInt16BE(afterName), len = buf.readUInt16BE(afterName + 8);
      const rdata = afterName + 10;
      if (type === 33 && len >= 6) {           // SRV
        const port = buf.readUInt16BE(rdata + 4);
        const [target] = readName(buf, rdata + 6);
        records.push({ kind: 'SRV', name, target, port });
      } else if (type === 12) {                 // PTR
        records.push({ kind: 'PTR', name, target: readName(buf, rdata)[0] });
      } else if (type === 1 && len === 4) {     // A
        records.push({ kind: 'A', name, ip: `${buf[rdata]}.${buf[rdata + 1]}.${buf[rdata + 2]}.${buf[rdata + 3]}` });
      }
      off = rdata + len;
    }
  return records;
}

const seen = new Map();   // service name -> last port
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sock.on('message', msg => {
  let recs;
  try { recs = parse(msg); } catch { return; }
  for (const r of recs) {
    if (r.kind !== 'SRV') continue;
    if (!/_osc(json)?\._(tcp|udp)/.test(r.name)) continue;
    if (filter && !r.name.includes(filter)) continue;
    const t = new Date().toISOString().slice(11, 23);
    const was = seen.get(r.name);
    if (was === r.port) continue;                       // repeat of the same announcement: quiet
    seen.set(r.name, r.port);
    console.log(`${t} ${was === undefined ? 'new ' : 'PORT CHANGED'} ${r.name} -> ${r.target}:${r.port}${was === undefined ? '' : ` (was ${was})`}`);
  }
});
sock.bind(5353, () => {
  try { sock.addMembership('224.0.0.251'); } catch (e) { console.error('multicast join failed:', e.message); }
  console.log(`listening ${seconds} s (receive only)`);
});
setTimeout(() => { console.log('--- summary'); for (const [n, p] of seen) console.log(`  ${n} -> ${p}`); sock.close(); }, seconds * 1000);
