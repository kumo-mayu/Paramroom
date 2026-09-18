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
      // 値は 0..255 で一周するので「種類」では数えられない。出てきた順に並べ、連続する重複を潰してから
      // 「1 つずつ増えているか」を見る。増え方が 2 以上なら、その間の値は拾われなかったということ。
      const seq = [];
      for (const x of seen) if (seq.length === 0 || seq[seq.length - 1] !== x.v) seq.push(x.v);
      // 送る値は 1 ずつ増やしているので、出てきた順に 1 ずつ増えていれば全部拾えている。
      // 2 以上増えていればその間が飛ばされた。逆戻りは UDP の順序入れ替わりで、間隔を詰めすぎると起きる。
      let skipped = 0, steps = 0, reordered = 0;
      for (let i = 1; i < seq.length; i++) {
        const d = (seq[i] - seq[i - 1] + 256) % 256;
        steps++;
        if (d === 1) continue;
        if (d > 128) reordered++;        // 逆戻り（順序の入れ替わり）
        else skipped += d - 1;
      }
      console.log(`送った値 ${sentCount} 個 / 出てきたメッセージ ${seen.length} 個 / 値の変化 ${seq.length} 回`);
      console.log(`  飛ばされた値: ${skipped} 個 / 順序の入れ替わり ${reordered} 回（変化 ${steps} 回のうち）`);
      if (reordered > steps / 20) console.log('  ※入れ替わりが多いので、この間隔では数えられません（間隔を伸ばしてください）');
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
      // VRChat がフレームごとにまとめて出しているなら、到着は塊になる。塊と塊の間隔が
      // 実際のループ周期（＝本当のフレームレート）。描画だけ止めて Update が回っている場合と区別できる。
      const burst = [];
      let last = seen[0].t, count = 1;
      for (let i = 1; i < seen.length; i++) {
        if (seen[i].t - seen[i - 1].t > 5) { burst.push({ gap: seen[i].t - last, n: count }); last = seen[i].t; count = 1; }
        else count++;
      }
      if (burst.length > 3) {
        const bg = burst.map(b => b.gap).sort((x, y) => x - y);
        const bq = p => bg[Math.min(bg.length - 1, Math.floor(bg.length * p))];
        const avgN = burst.reduce((a, b) => a + b.n, 0) / burst.length;
        console.log(`  塊の間隔 ミリ秒: 中央 ${bq(0.5)} / 10% ${bq(0.1)} / 90% ${bq(0.9)}（塊 ${burst.length} 個、1 塊あたり ${avgN.toFixed(1)} 個）`);
        console.log(`  → ループ周期がこの間隔なら、実際のフレームレートは約 ${(1000 / bq(0.5)).toFixed(0)} fps`);
      }
      console.log(`  拾えた割合: ${((seq.length) / sentCount * 100).toFixed(0)} %（値の変化 ÷ 送った数）`);
    }, 500);
  }, seconds * 1000);
});
