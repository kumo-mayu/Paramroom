'use strict';
// Prototype: MS-SSIM (YCbCr 3 planes, 5 scales) on WebGPU (float32) vs CPU (float64). Measures latency & error.
// usage: node review/gpu-msssim-proto.js   (requires: npm i webgpu in a scratch dir; set WEBGPU_PATH)
const { create, globals } = require(process.env.WEBGPU_PATH || 'webgpu');
Object.assign(globalThis, globals);
const I = require('../lib/image');
const M = require('../lib/metrics');

const G = (() => { const g = [], s = 1.5; let sum = 0; for (let i = -5; i <= 5; i++) { g.push(Math.exp(-i * i / (2 * s * s))); sum += g[g.length - 1]; } return g.map(v => v / sum); })();

// One compute shader: input x,y (w*h); outputs per 'valid' pixel: ssim and cs maps via blurred stats.
// Two passes: horizontal blur of [x, y, x2, y2, xy] into tmp (5 channels), vertical into stats; then ssim.
const WGSL = `
struct P { w: u32, h: u32, stage: u32, pad: u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> y: array<f32>;
@group(0) @binding(3) var<storage, read_write> tmp: array<f32>;   // (w-10)*h*5
@group(0) @binding(4) var<storage, read_write> outm: array<f32>;  // (w-10)*(h-10)*2
const G = array<f32, 11>(${G.map(v => v.toFixed(10)).join(', ')});
const C1: f32 = ${((0.01 * 255) ** 2).toFixed(6)};
const C2: f32 = ${((0.03 * 255) ** 2).toFixed(6)};
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let W = p.w - 10u;
  if (p.stage == 0u) {
    if (id.x >= W || id.y >= p.h) { return; }
    var s = array<f32, 5>(0.0, 0.0, 0.0, 0.0, 0.0);
    for (var k = 0u; k < 11u; k++) {
      let i = id.y * p.w + id.x + k;
      let a = x[i]; let b = y[i];
      s[0] += G[k] * a; s[1] += G[k] * b; s[2] += G[k] * a * a; s[3] += G[k] * b * b; s[4] += G[k] * a * b;
    }
    let o = (id.y * W + id.x) * 5u;
    for (var c = 0u; c < 5u; c++) { tmp[o + c] = s[c]; }
  } else {
    let H = p.h - 10u;
    if (id.x >= W || id.y >= H) { return; }
    var s = array<f32, 5>(0.0, 0.0, 0.0, 0.0, 0.0);
    for (var k = 0u; k < 11u; k++) {
      let o = ((id.y + k) * W + id.x) * 5u;
      for (var c = 0u; c < 5u; c++) { s[c] += G[k] * tmp[o + c]; }
    }
    let vx = s[2] - s[0] * s[0]; let vy = s[3] - s[1] * s[1]; let cxy = s[4] - s[0] * s[1];
    let cs = (2.0 * cxy + C2) / (vx + vy + C2);
    let o = (id.y * W + id.x) * 2u;
    outm[o] = ((2.0 * s[0] * s[1] + C1) / (s[0] * s[0] + s[1] * s[1] + C1)) * cs;
    outm[o + 1u] = cs;
  }
}`;

async function main() {
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: WGSL });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const MS_W = [0.0448, 0.2856, 0.3001, 0.2363, 0.1333];

  function buf(size, usage) { return device.createBuffer({ size: Math.ceil(size / 4) * 4, usage }); }
  // pre-allocate per scale
  const scales = [];
  for (let s = 0, n = 256; s < 5; s++, n >>= 1) {
    const W = n - 10, H = n - 10;
    scales.push({
      n, W, H,
      x: buf(n * n * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      y: buf(n * n * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      tmp: buf(W * n * 5 * 4, GPUBufferUsage.STORAGE),
      out: buf(W * H * 2 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
      read: buf(W * H * 2 * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
      uni: [0, 1].map(pass => { const u = buf(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST); device.queue.writeBuffer(u, 0, new Uint32Array([n, n, pass, 0])); return u; }),
    });
  }
  const down2 = (d, n) => { const m = n >> 1, o = new Float32Array(m * m); for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) o[y * m + x] = (d[2 * y * n + 2 * x] + d[2 * y * n + 2 * x + 1] + d[(2 * y + 1) * n + 2 * x] + d[(2 * y + 1) * n + 2 * x + 1]) / 4; return o; };
  const planes = img => { const n = 65536, Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n); for (let i = 0; i < n; i++) { const r = Math.max(0, Math.min(255, img.data[i * 3])), g = Math.max(0, Math.min(255, img.data[i * 3 + 1])), b = Math.max(0, Math.min(255, img.data[i * 3 + 2])); Y[i] = 0.299 * r + 0.587 * g + 0.114 * b; Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128; Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128; } return [Y, Cb, Cr]; };

  async function msssimGPU(ref, img) {
    const a = planes(ref), b = planes(img);
    const res = [];
    for (let ch = 0; ch < 3; ch++) {
      let xa = a[ch], yb = b[ch];
      const enc = device.createCommandEncoder();
      for (let s = 0; s < 5; s++) {
        const S = scales[s];
        device.queue.writeBuffer(S.x, 0, xa); device.queue.writeBuffer(S.y, 0, yb);
        for (const pass of [0, 1]) {
          const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: S.uni[pass] } }, { binding: 1, resource: { buffer: S.x } }, { binding: 2, resource: { buffer: S.y } },
            { binding: 3, resource: { buffer: S.tmp } }, { binding: 4, resource: { buffer: S.out } }] });
          const cp = enc.beginComputePass(); cp.setPipeline(pipeline); cp.setBindGroup(0, bg);
          cp.dispatchWorkgroups(Math.ceil(S.W / 16), Math.ceil(S.n / 16)); cp.end();
        }
        enc.copyBufferToBuffer(S.out, 0, S.read, 0, S.W * S.H * 2 * 4);
        if (s < 4) { xa = down2(xa, S.n); yb = down2(yb, S.n); }
      }
      device.queue.submit([enc.finish()]);
      let val = 1, s0 = 0;
      for (let s = 0; s < 5; s++) {
        const S = scales[s];
        await S.read.mapAsync(GPUMapMode.READ);
        const m = new Float32Array(S.read.getMappedRange().slice(0));
        S.read.unmap();
        let ss = 0, cs = 0; const n = S.W * S.H;
        for (let i = 0; i < n; i++) { ss += m[2 * i]; cs += m[2 * i + 1]; }
        ss /= n; cs /= n;
        if (s === 0) s0 = ss;
        val *= s === 4 ? Math.pow(Math.max(ss, 1e-6), MS_W[s]) : Math.pow(Math.max(cs, 1e-6), MS_W[s]);
      }
      res.push([s0, val]);
    }
    return { msssimc: (6 * res[0][1] + res[1][1] + res[2][1]) / 8, ssimc: (6 * res[0][0] + res[1][0] + res[2][0]) / 8 };
  }

  const ref = I.loadPNG('images/ref/kodim23.png');
  const tests = ['kodim05', 'illust_tux', 'screenshot_mahara', 'kodim23'].map(n => I.loadPNG(`images/ref/${n}.png`));
  // near-reference image (small noise) to check precision where it matters
  const near = { ...ref, data: ref.data.map(v => v + (Math.random() - 0.5) * 6) };
  tests.push(near);
  await msssimGPU(ref, tests[0]); // warm-up
  let maxErr = 0;
  for (const t of tests) {
    const g = await msssimGPU(ref, t), c = M.all(ref, t);
    maxErr = Math.max(maxErr, Math.abs(g.msssimc - c.msssimc), Math.abs(g.ssimc - c.ssimc));
    console.log(`cpu ${c.msssimc.toFixed(6)} gpu ${g.msssimc.toFixed(6)}`);
  }
  const N = 40;
  let t0 = Date.now();
  for (let i = 0; i < N; i++) await msssimGPU(ref, tests[i % tests.length]);
  const gms = (Date.now() - t0) / N;
  t0 = Date.now();
  for (let i = 0; i < N; i++) M.all(ref, tests[i % tests.length]);
  const cms = (Date.now() - t0) / N;
  console.log(`max |gpu-cpu| = ${maxErr.toExponential(2)}; GPU ${gms.toFixed(1)} ms/call, CPU(optimised, incl. PSNR) ${cms.toFixed(1)} ms/call`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
