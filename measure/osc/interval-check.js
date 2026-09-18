'use strict';
// 送信アプリが、決めた間隔どおりにパケットを出しているかを測る（docs/research/12）。
// UDP で受けて到着時刻を記録し、間隔の分布を出す。送信側の描画や CPU の混み具合で
// 揺れるかどうかを見るためのもの。
//   node interval-check.js [port=9131] [seconds=20]
const dgram = require('dgram');
const port = Number(process.argv[2] || 9131), seconds = Number(process.argv[3] || 20);
const sock = dgram.createSocket('udp4');
const times = [];
sock.on('message', () => times.push(process.hrtime.bigint()));
sock.bind(port, '127.0.0.1', () => console.error(`127.0.0.1:${port} で ${seconds} 秒受けます`));
setTimeout(() => {
  sock.close();
  if (times.length < 3) { console.log('パケットが来ませんでした'); process.exit(1); }
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(Number(times[i] - times[i - 1]) / 1e6);
  gaps.sort((a, b) => a - b);
  const q = p => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  console.log(`パケット ${times.length} 個、間隔 ミリ秒:`);
  console.log(`  平均 ${mean.toFixed(1)} / 中央 ${q(0.5).toFixed(1)} / 最小 ${gaps[0].toFixed(1)} / 90% ${q(0.9).toFixed(1)} / 99% ${q(0.99).toFixed(1)} / 最大 ${gaps[gaps.length - 1].toFixed(1)}`);
  console.log(`  100 ミリ秒から 20 ミリ秒以上ずれた回数: ${gaps.filter(g => Math.abs(g - 100) >= 20).length} / ${gaps.length}`);
}, seconds * 1000);
