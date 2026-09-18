'use strict';
// QR 専用モードの参照実装（docs/research/09 §6 の詰め方 A+）。
//
// 画像モードの割り付けを借りないので、Int が少なくても成立する。パケットは
//   [epoch 2][ユニット番号 u][中身]
//   ユニット 0 の中身 = [版 6][マス...]、ユニット i の中身 = [マス...]
// 中身は 1 bit = 1 マス。ただし**三隅の切り出しパターンと分離帯（8x8 を 3 つ = 192 マス）は送らない**。
// あの模様は版によらず同じなので受信側が描ける。行優先で数えた「前にある除外マス数」は閉じた式で出るから、
// シェーダ側の添字の計算も足し算で済む。
//
// u は「対応する最大の版」で決める（プレハブに焼き込むので、小さい QR のときは少し無駄になる）。
const HEAD = 6;          // 版（1..40 を 0..39 として 6 bit）
const MAX_VERSION = 10;  // 57x57。これ以上は表示板の解像度的にもカメラ的にも実用外（§5 未検証）
const CORNER = 8;        // 切り出しパターン 7x7 ＋ 分離帯 1 = 8x8

const sideOf = (v) => 17 + 4 * v;
const skipped = (n, x, y) =>
  (y < CORNER && (x < CORNER || x >= n - CORNER)) || (y >= n - CORNER && x < CORNER);

// 行優先で (x,y) より前にある除外マスの数
function skippedBefore(n, x, y) {
  let s;
  if (y < CORNER) s = 16 * y;
  else if (y < n - CORNER) s = 16 * CORNER;
  else s = 16 * CORNER + CORNER * (y - (n - CORNER));
  if (y < CORNER) s += Math.min(x, CORNER) + Math.max(0, x - (n - CORNER));
  else if (y >= n - CORNER) s += Math.min(x, CORNER);
  return s;
}

// 切り出しパターン（分離帯を含む 8x8）の色。true = 黒
function finder(n, x, y) {
  let u, v;                                   // 模様の中での位置（7x7）
  if (y < CORNER && x < CORNER) { u = x; v = y; }
  else if (y < CORNER) { u = x - (n - 7); v = y; }
  else { u = x; v = y - (n - 7); }
  if (u < 0 || u > 6 || v < 0 || v > 6) return false;   // 分離帯は白
  return u === 0 || u === 6 || v === 0 || v === 6 || (u >= 2 && u <= 4 && v >= 2 && v <= 4);
}

// bytes = 同期する Int の数。u は最大の版で決まる
function layout(bytes, maxVersion = MAX_VERSION) {
  const P = 8 * bytes - 2;
  const maxCells = cellCount(sideOf(maxVersion));
  for (let u = 1; u <= 12; u++) {
    const pay = P - u;
    if (pay <= HEAD) continue;
    const first = pay - HEAD;
    const maxUnits = 1 + Math.ceil((maxCells - first) / pay);
    if (maxUnits <= (1 << u)) return { bytes, P, u, pay, first, maxUnits };
  }
  return null;
}

const cellCount = (n) => n * n - 3 * CORNER * CORNER;

function unitsNeeded(L, n) {
  const cells = cellCount(n);
  return cells <= L.first ? 1 : 1 + Math.ceil((cells - L.first) / L.pay);
}

// modules: n*n の 0/1（行優先）。戻りは各ユニットの P bit 配列
function encode(modules, n, L) {
  const v = (n - 17) / 4;
  if (!Number.isInteger(v) || v < 1 || v > 40) throw new Error('qronly: 版が不正 ' + n);
  const need = unitsNeeded(L, n);
  if (need > L.maxUnits) throw new Error(`qronly: ${n}x${n} には ${need} パケット要るが ${L.maxUnits} まで`);
  const units = [];
  let j = 0;                                   // 送るマスの通し番号
  const cells = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!skipped(n, x, y)) cells.push(modules[y * n + x]);
  for (let id = 0; id < need; id++) {
    const u = new Array(L.P).fill(0);
    let o = 0;
    for (let b = L.u - 1; b >= 0; b--) u[o++] = (id >> b) & 1;
    if (id === 0) for (let b = HEAD - 1; b >= 0; b--) u[o++] = ((v - 1) >> b) & 1;
    const room = id === 0 ? L.first : L.pay;
    for (let i = 0; i < room && j < cells.length; i++) u[o++] = cells[j++] ? 1 : 0;
    units.push(u);
  }
  return { units, layout: L, modules: n, version: v };
}

// 受信側。apply したユニットだけが見える
function decoder(L) {
  let version = 0;
  const have = new Map();                      // ユニット番号 -> 中身の bit 配列
  return {
    apply(unit) {
      let id = 0, o = 0;
      for (let b = 0; b < L.u; b++) id = (id << 1) | unit[o++];
      if (id === 0) { let v = 0; for (let b = 0; b < HEAD; b++) v = (v << 1) | unit[o++]; version = v + 1; }
      have.set(id, unit.slice(o));
    },
    get version() { return version; },
    // 1 マス 1 画素の絵（余白 quiet マス付き、0..255 の RGB）
    render(quiet = 4) {
      const n = version ? sideOf(version) : sideOf(1);
      const side = n + 2 * quiet;
      const img = { w: side, h: side, c: 3, data: new Float64Array(side * side * 3).fill(255) };
      if (!version) return img;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        let black;
        if (skipped(n, x, y)) black = finder(n, x, y);
        else {
          const j = y * n + x - skippedBefore(n, x, y);
          const id = j < L.first ? 0 : 1 + Math.floor((j - L.first) / L.pay);
          const off = j < L.first ? j : (j - L.first) % L.pay;
          const bits = have.get(id);
          black = bits ? bits[off] === 1 : false;
        }
        if (!black) continue;
        const p = ((quiet + y) * side + (quiet + x)) * 3;
        img.data[p] = img.data[p + 1] = img.data[p + 2] = 0;
      }
      return img;
    },
  };
}

module.exports = { HEAD, MAX_VERSION, CORNER, sideOf, skipped, skippedBefore, finder, layout, cellCount, unitsNeeded, encode, decoder };
