'use strict';
// Join decoded video frames with the OSC sender log and summarise channel behaviour per test run (epoch).
// usage: node analyze.js <decoded.csv> <sender-log.csv> [--out report.md]
// Boards are labelled by their IsLocal cell: local (sender's own client) / remote (other client).
// Clock alignment: video time -> sender time offset = median over sequence numbers of
//   (first local sighting in video) - (send start in log); falls back to remote sightings if no local board.
const fs = require('fs');

const argv = process.argv.slice(2);
const [decodedPath, logPath] = argv;
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
if (!decodedPath || !logPath) { console.log('usage: node analyze.js <decoded.csv> <sender-log.csv> [--out report.md]'); process.exit(1); }
const outPath = opt('out', decodedPath.replace(/\.csv$/, '') + '.report.md');
// --ignoreConsistency: count a sequence number as seen even when the board's consistency flag is 0
// (recordings made with the old prefab, where zero bytes stayed stale); torn/exactness columns are then invalid.
const ignoreConsistency = argv.includes('--ignoreConsistency');

function readCsv(p) {
  const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map(l => { const v = l.split(','); const o = {}; head.forEach((h, i) => (o[h] = isNaN(+v[i]) ? v[i] : +v[i])); return o; });
}
const frames = readCsv(decodedPath).filter(r => r.valid === 1);
const sent = [].concat(...logPath.split('+').map(readCsv)); // several logs can be joined with '+'
const sentKeys = new Set(sent.map(s => `${s.epoch}:${s.seq}`));
const fps = (() => { const f = frames.find(r => r.frame > 0); return f ? f.frame / (f.timeMs / 1000) : 60; })();
const frameMs = 1000 / fps;

// per board label: first sighting time of each consistent seq, torn episodes, etc.
const boards = { local: [], remote: [] };
for (const r of frames) boards[r.isLocal ? 'local' : 'remote'].push(r);

function sightings(rows) {
  const first = new Map(); // key epoch:seq -> timeMs
  for (const r of rows) {
    if ((!ignoreConsistency && !r.consistent) || r.allZero) continue;
    const k = `${r.epoch}:${r.seq}`;
    if (ignoreConsistency && !sentKeys.has(k)) continue;
    if (!first.has(k)) first.set(k, r.timeMs);
  }
  return first;
}
const seen = { local: sightings(boards.local), remote: sightings(boards.remote) };
const sentBy = new Map(sent.map(s => [`${s.epoch}:${s.seq}`, s]));

function median(a) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
function pct(a, p) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }

const refBoard = seen.local.size ? 'local' : 'remote';
const offsets = [];
for (const [k, t] of seen[refBoard]) { const s = sentBy.get(k); if (s) offsets.push(t - s.sendStartMs); }
const offset = refBoard === 'local' ? median(offsets) : Math.min(...offsets);

const lines = [];
const P = s => lines.push(s);
P(`# 実機測定レポート`);
P(`- 動画: \`${decodedPath}\`（有効フレーム ${frames.length}、推定 ${fps.toFixed(1)} fps）`);
P(`- 送信ログ: \`${logPath}\`（${sent.length} パケット）`);
P(`- ボード: local ${boards.local.length} フレーム / remote ${boards.remote.length} フレーム`);
if (ignoreConsistency) P('- 注意: 整合フラグを無視して集計（旧プレハブの録画）。半端パケット・厳密値の列は無効');
P(`- 時刻合わせ: ${refBoard} ボード基準、オフセット ${offset.toFixed(1)} ms`);
P('');

const epochs = [...new Set(sent.map(s => s.epoch))].sort((a, b) => a - b);
P('## テストラン（epoch）ごとの結果');
P('');
P('| epoch | 保持 ms | 送信方式 | 送信数 | local 欠落率 | remote 欠落率 | remote 観測間隔 中央値/90% ms | remote 遅延(local比) 中央値/90% ms | remote 半端フレーム列 | remote 厳密値NG率 |');
P('|---:|---:|---|---:|---:|---:|---|---|---:|---:|');
for (const ep of epochs) {
  const rows = sent.filter(s => s.epoch === ep);
  const hold = median(rows.map(r => r.holdMs));
  const how = `${rows[0].bundle ? 'bundle' : 'msgs'}/${rows[0].order}${rows[0].msgDelay ? '/delay' + rows[0].msgDelay : ''}`;
  // ignore the last 2 s of each run (packets whose sighting could fall after the run)
  const tEnd = Math.max(...rows.map(r => r.sendStartMs)) - 2000;
  const core = rows.filter(r => r.sendStartMs <= tEnd);
  const loss = b => core.length ? 1 - core.filter(r => seen[b].has(`${ep}:${r.seq}`)).length / core.length : NaN;
  const remTimes = core.map(r => seen.remote.get(`${ep}:${r.seq}`)).filter(t => t !== undefined).sort((a, b) => a - b);
  const gaps = remTimes.slice(1).map((t, i) => t - remTimes[i]);
  const lat = core.map(r => { const a = seen.remote.get(`${ep}:${r.seq}`), b = seen.local.get(`${ep}:${r.seq}`); return a !== undefined && b !== undefined ? a - b : undefined; }).filter(x => x !== undefined);
  // torn: maximal runs of inconsistent, non-zero frames on the remote board during this run
  const t0 = Math.min(...rows.map(r => r.sendStartMs)) + offset, t1 = Math.max(...rows.map(r => r.sendStartMs)) + offset + 1000;
  const rem = boards.remote.filter(r => r.timeMs >= t0 && r.timeMs <= t1);
  let torn = 0, inRun = false, inexact = 0;
  for (const r of rem) {
    const bad = !r.consistent && !r.allZero;
    if (bad && !inRun) torn++;
    inRun = bad;
    if (!r.exact) inexact++;
  }
  const f = x => (isNaN(x) ? '-' : (100 * x).toFixed(1) + '%');
  P(`| ${ep} | ${hold} | ${how} | ${core.length} | ${f(loss('local'))} | ${f(loss('remote'))} | ${gaps.length ? median(gaps).toFixed(0) + ' / ' + pct(gaps, 0.9).toFixed(0) : '-'} | ${lat.length ? median(lat).toFixed(0) + ' / ' + pct(lat, 0.9).toFixed(0) : '-'} | ${torn} | ${rem.length ? f(inexact / rem.length) : '-'} |`);
}
P('');

// remote inter-sighting interval histogram (all runs)
const allRem = [...seen.remote.values()].sort((a, b) => a - b);
const gapsAll = allRem.slice(1).map((t, i) => t - allRem[i]).filter(g => g < 2000);
const bins = new Map();
for (const g of gapsAll) { const b = Math.round(g / frameMs); bins.set(b, (bins.get(b) || 0) + 1); }
P('## remote で新しいパケットが観測される間隔（全ラン、2 秒未満）');
P('');
P('| 間隔（フレーム） | ≈ms | 回数 |');
P('|---:|---:|---:|');
for (const b of [...bins.keys()].sort((a, c) => a - c)) P(`| ${b} | ${(b * frameMs).toFixed(0)} | ${bins.get(b)} |`);
P('');

// torn run lengths on remote, all-zero sightings, loop counter behaviour
function runLengths(rows, pred) {
  const out = []; let n = 0;
  for (const r of rows) { if (pred(r)) n++; else if (n) { out.push(n); n = 0; } }
  if (n) out.push(n);
  return out;
}
for (const b of ['local', 'remote']) {
  const rows = boards[b];
  if (!rows.length) continue;
  const torn = runLengths(rows, r => !r.consistent && !r.allZero);
  const zeros = runLengths(rows, r => r.allZero);
  let loopInc = 0, loopSame = 0, loopZero = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].loop === 0) loopZero++;
    else if (rows[i].loop > rows[i - 1].loop) loopInc++;
    else loopSame++;
  }
  P(`## ${b} ボード`);
  P(`- 半端（不整合）フレーム列: ${torn.length} 回、長さ（フレーム）中央値 ${median(torn) || '-'}、最大 ${torn.length ? Math.max(...torn) : '-'}`);
  P(`- 全ゼロ表示のフレーム列: ${zeros.length} 回、長さ中央値 ${median(zeros) || '-'}`);
  P(`- 厳密値NG フレーム: ${rows.filter(r => !r.exact).length} / ${rows.length}`);
  P(`- IsOnFriendsList=1 のフレーム: ${rows.filter(r => r.isFriend).length} / ${rows.length}`);
  P(`- カメラループカウンタ: 増加 ${loopInc}、停止 ${loopSame}、0（未動作）${loopZero} フレーム`);
  P('');
}
fs.writeFileSync(outPath, lines.join('\n'));
console.log(lines.join('\n'));
console.log('\nwrote ' + outPath);
