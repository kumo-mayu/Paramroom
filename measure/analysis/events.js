'use strict';
// Late-join / culling events: periods where the remote board is not visible, and what it shows when it reappears.
// usage: node events.js <decoded.csv> <sender-log.csv> [--minGapFrames 30]
const fs = require('fs');
const argv = process.argv.slice(2);
const [decodedPath, logPath] = argv;
const mgi = argv.indexOf('--minGapFrames');
const minGap = mgi >= 0 ? Number(argv[mgi + 1]) : 30;

function readCsv(p) {
  const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map(l => { const v = l.split(','); const o = {}; head.forEach((h, i) => (o[h] = +v[i])); return o; });
}
const rows = readCsv(decodedPath).filter(r => r.valid === 1);
const sent = readCsv(logPath);
const nFrames = Math.max(...rows.map(r => r.frame)) + 1;
const local = new Array(nFrames).fill(null), remote = new Array(nFrames).fill(null);
for (const r of rows) (r.isLocal ? local : remote)[r.frame] = r;
const fps = 60, ms = f => (f * 1000 / fps);

// packet index by seq (idle run: seq increases by one per packet)
const seqIndex = new Map(sent.map((s, i) => [s.seq, i]));
// latest packet shown on the local board at frame f (reference for "current" state)
let lastLocal = null;
const localAt = new Array(nFrames);
for (let f = 0; f < nFrames; f++) { if (local[f] && local[f].consistent) lastLocal = local[f]; localAt[f] = lastLocal; }

const events = [];
let gapStart = null;
for (let f = 0; f < nFrames; f++) {
  const vis = remote[f] !== null;
  if (!vis && gapStart === null) gapStart = f;
  if (vis && gapStart !== null) {
    if (f - gapStart >= minGap) events.push({ start: gapStart, end: f });
    gapStart = null;
  }
}
console.log(`# 途中参加・非表示イベント（remote ボードが ${minGap} フレーム以上見えなかった区間）\n`);
console.log('| # | 非表示開始 s | 長さ s | 再表示直後の表示 | 最新パケットとの差（パケット数） | 最新に追いつくまで ms | 全ゼロ表示フレーム | 不整合フレーム（最初の1秒） | ループカウンタ 前→後 |');
console.log('|---:|---:|---:|---|---:|---:|---:|---:|---|');
events.forEach((e, i) => {
  const first = remote[e.end];
  const before = (() => { for (let f = e.start - 1; f >= 0; f--) if (remote[f]) return remote[f]; return null; })();
  const cur = localAt[e.end];
  const lag = first && cur && seqIndex.has(first.seq) && seqIndex.has(cur.seq) ? seqIndex.get(cur.seq) - seqIndex.get(first.seq) : NaN;
  // time until remote shows a consistent packet at least as new as the local packet at reappearance
  let catchUp = NaN;
  for (let f = e.end; f < Math.min(nFrames, e.end + 600); f++) {
    const r = remote[f];
    if (r && r.consistent && cur && seqIndex.has(r.seq) && seqIndex.get(r.seq) >= seqIndex.get(cur.seq)) { catchUp = ms(f - e.end); break; }
  }
  let zeros = 0, incons = 0;
  for (let f = e.end; f < Math.min(nFrames, e.end + 60); f++) { const r = remote[f]; if (!r) continue; if (r.allZero) zeros++; else if (!r.consistent) incons++; }
  const shown = !first ? '-' : first.allZero ? '全ゼロ' : first.consistent ? `seq ${first.seq}` : `不整合 seq ${first.seq}`;
  console.log(`| ${i + 1} | ${(ms(e.start) / 1000).toFixed(1)} | ${(ms(e.end - e.start) / 1000).toFixed(1)} | ${shown} | ${isNaN(lag) ? '-' : lag} | ${isNaN(catchUp) ? '-' : catchUp.toFixed(0)} | ${zeros} | ${incons} | ${before ? before.loop : '-'} → ${first ? first.loop : '-'} |`);
});
