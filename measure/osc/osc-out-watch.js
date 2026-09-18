'use strict';
// VRChat が「送った値をいくつ拾ったか」を数える（docs/research/10）。
//
// VRChat はアバターのパラメータが変わると OSC で外に出す（既定 9001）。こちらから 9000 に
// 値を送り込み、9001 に出てくる値を数えれば、**VRChat が 1 つ 1 つの値を拾えているか**が分かる。
// 送信側の fps を落としたときに値が飛ばされるか（推測のまま残っている点）を、1 台だけで確かめられる。
//
// 使い方（VRChat を起動し、Paramroom 入りのアバターを着て、OSC を有効にしておく）:
//   node osc-out-watch.js Paramroom_D0 [--seconds 20] [--hold 100] [--in 9000] [--out 9001]
// 出てきた値の数が送った数とほぼ同じなら、その fps でも取りこぼしていない。
const dgram = require('dgram');

const args = process.argv.slice(2);
const param = args[0] && !args[0].startsWith('--') ? args[0] : 'Paramroom_D0';
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : Number(args[i + 1]); };
const seconds = opt('seconds', 20), hold = opt('hold', 100);
const inPort = opt('in', 9000), outPort = opt('out', 9001);
const addr = `/avatar/parameters/${param}`;

// ---- OSC の組み立て・読み取り（int だけ）
function pad(n) { return (4 - (n % 4)) % 4; }
function str(s) { const b = Buffer.from(s + '\0', 'ascii'); return Buffer.concat([b, Buffer.alloc(pad(b.length))]); }
function intMsg(a, v) {
  const val = Buffer.alloc(4); val.writeInt32BE(v);
  return Buffer.concat([str(a), str(',i'), val]);
}
function parse(buf) {
  let o = 0;
  const readStr = () => { let e = o; while (buf[e] !== 0) e++; const s = buf.toString('ascii', o, e); o = (e + 4) & ~3; return s; };
  const a = readStr();
  if (a === '#bundle') return [];           // バンドルは今回使わない
  const tags = readStr();
  if (tags !== ',i') return [{ addr: a, value: null }];
  return [{ addr: a, value: buf.readInt32BE(o) }];
}

const send = dgram.createSocket('udp4');
const recv = dgram.createSocket('udp4');
const seen = [];
let sentCount = 0;

recv.on('message', b => {
  for (const m of parse(b)) if (m.addr === addr && m.value !== null) seen.push({ t: Date.now(), v: m.value });
});
recv.bind(outPort, '127.0.0.1', () => {
  console.error(`${addr} を ${hold} ms ごとに変えながら、127.0.0.1:${outPort} に出てくる値を ${seconds} 秒数えます`);
  let v = 0;
  const timer = setInterval(() => {
    v = (v + 1) % 256;                      // 毎回違う値（0 は epoch 0 扱いされうるので気にしない）
    send.send(intMsg(addr, v), inPort, '127.0.0.1');
    sentCount++;
  }, hold);
  setTimeout(() => {
    clearInterval(timer);
    setTimeout(() => {
      recv.close(); send.close();
      const distinct = new Set(seen.map(s => s.v)).size;
      console.log(`送った値 ${sentCount} 個 / 出てきた値 ${seen.length} 個（種類 ${distinct}）`);
      if (seen.length === 0) {
        console.log('  何も出てきませんでした。OSC の出力が無効か、そのパラメータがアバターに無いか、');
        console.log('  VRChat が OSC で書いた値を外に出さない作りのどちらかです。');
        return;
      }
      const gaps = [];
      for (let i = 1; i < seen.length; i++) gaps.push(seen[i].t - seen[i - 1].t);
      gaps.sort((a, b) => a - b);
      const q = p => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
      console.log(`  出てきた間隔 ミリ秒: 中央 ${q(0.5)} / 90% ${q(0.9)} / 最大 ${gaps[gaps.length - 1]}`);
      console.log(`  拾えた割合: ${(seen.length / sentCount * 100).toFixed(0)} %`);
    }, 500);
  }, seconds * 1000);
});
