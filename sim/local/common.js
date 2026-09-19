'use strict';
// 新用途（PC → 自分のアバターへのローカル転送 → カメラジャック → Print）の符号化方式比較の共通部分。
// docs/research/12。評価は「閾値の画質に届くのに要るビット数」。パケット化は転送層（1 チャンク 868 bit）に任せ、
// ここでは各方式が出すビット列の長さだけを数える。
const path = require('path');
const I = require('../lib/image');
const M = require('../lib/metrics');

const SRC = path.join(__dirname, '..', 'images', 'src');

// テスト画像は元の解像度のまま使う（拡大すると圧縮しやすくなり、有利に出るため）。長辺は最大 960。
// 縦長すぎるスクリーンショットだけ上端を正方形に切る。
const SET = [
  ['kodim01', 'photo'], ['kodim03', 'photo'], ['kodim04', 'photo'], ['kodim05', 'photo'], ['kodim07', 'photo'],
  ['kodim08', 'photo'], ['kodim15', 'photo'], ['kodim19', 'photo'], ['kodim20', 'photo'], ['kodim23', 'photo'],
  ['illust_wikipetan_face', 'illust'], ['illust_tux', 'illust'], ['illust_pc_newyear', 'illust'], ['illust_chibi', 'illust'],
  ['screenshot_wikipedia', 'screen'], ['screenshot_mahara', 'screen'],
];
// 文字の読みやすさを見る切り出し（元画像の座標。本文の段落）
const TEXT = {
  screenshot_wikipedia: [100, 195, 360, 205],
  screenshot_mahara: [40, 140, 650, 220],
};

function loadImage(name) {
  let img = I.loadPNG(path.join(SRC, name + '.png'));
  if (name === 'screenshot_wikipedia') img = I.crop(img, 0, 0, 960, 960);
  return I.quantize8(img);
}

function loadSet(filter) {
  return SET.filter(([n]) => !filter || filter.includes(n)).map(([name, kind]) => ({ name, kind, img: loadImage(name) }));
}

// 受信側は 8 bit の RenderTexture に描くので、再構成は 8 bit に丸めてから測る
function evaluate(entry, rec) {
  const r = I.quantize8({ ...rec, data: Float64Array.from(rec.data) });
  const m = M.all(entry.img, r);
  const out = { msssimc: m.msssimc, psnr: m.psnr, msssim: m.msssim };
  const t = TEXT[entry.name];
  if (t) {
    const a = I.crop(entry.img, ...t), b = I.crop(r, ...t);
    const mt = M.all(a, b);
    out.text_msssimc = mt.msssimc; out.text_psnr = mt.psnr;
  }
  return out;
}

// ---- 色空間（JPEG と同じ BT.601 フルレンジ）
function toPlanes(img) {
  const [Y, Cb, Cr] = I.rgbToYcc(img);
  return [Y, Cb, Cr];
}
function fromPlanes(Y, Cb, Cr) { return I.clamp255(I.yccToRgb(Y, Cb, Cr)); }

// 平面（c=1）の縮小・拡大（2 のべき以外にも対応）
function planeResize(p, W, H) { return I.resize(p, W, H); }

// 画像の縮小 → 符号化 → 元の大きさへ拡大（GPU のバイリニアと同じ）。scale=1 はそのまま
function scaled(img, scale, fn) {
  if (scale === 1) return fn(img);
  const W = Math.max(8, Math.round(img.w * scale)), H = Math.max(8, Math.round(img.h * scale));
  const small = I.resize(img, W, H);
  const r = fn(small);
  return { ...r, rec: I.resizeBilinear(r.rec, img.w, img.h) };
}

// k-means（RGB などのベクトル、Float64Array の行列 n×d）。k-means++ 初期化、決定的な乱数
function kmeans(data, n, d, k, iters = 15, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const C = new Float64Array(k * d);
  const dist = new Float64Array(n).fill(Infinity);
  let first = Math.floor(rnd() * n);
  for (let j = 0; j < d; j++) C[j] = data[first * d + j];
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let e = 0;
      for (let j = 0; j < d; j++) { const t = data[i * d + j] - C[(c - 1) * d + j]; e += t * t; }
      if (e < dist[i]) dist[i] = e;
      sum += dist[i];
    }
    let r = rnd() * sum, pick = n - 1;
    for (let i = 0; i < n; i++) { r -= dist[i]; if (r <= 0) { pick = i; break; } }
    for (let j = 0; j < d; j++) C[c * d + j] = data[pick * d + j];
  }
  const assign = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let best = 0, be = Infinity;
      for (let c = 0; c < k; c++) {
        let e = 0;
        for (let j = 0; j < d && e < be; j++) { const t = data[i * d + j] - C[c * d + j]; e += t * t; }
        if (e < be) { be = e; best = c; }
      }
      assign[i] = best;
    }
    const sum = new Float64Array(k * d), cnt = new Float64Array(k);
    for (let i = 0; i < n; i++) { cnt[assign[i]]++; for (let j = 0; j < d; j++) sum[assign[i] * d + j] += data[i * d + j]; }
    for (let c = 0; c < k; c++) if (cnt[c]) for (let j = 0; j < d; j++) C[c * d + j] = sum[c * d + j] / cnt[c];
  }
  return { C, assign };
}

// ---- 転送層（1 チャンク = データ 31 個 × 28 bit = 868 bit。1 組 = Float 32 個 = K/32 組/フレーム）
const CHUNK_BITS = 868;
function seconds(bits, K, fps, eff = 0.9) {
  const chunks = Math.ceil(bits / CHUNK_BITS);
  const perFrame = (K / 32) * eff;
  return chunks / perFrame / fps;
}

module.exports = { SET, TEXT, loadSet, loadImage, evaluate, toPlanes, fromPlanes, planeResize, scaled, kmeans, CHUNK_BITS, seconds, I, M };
