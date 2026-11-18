// SPDX-License-Identifier: Apache-2.0
// Optional GPU validation of the colour WGSL with Dawn (npm "webgpu"), outside the vitest suite:
// compiles COMMON_WGSL / CDL / false colour / every inputTransformWGSL, runs them in a compute
// shader against the CPU reference, and checks LUT sampling (hardware filter + sl_lut_trilinear)
// against applyViewCPU.
//   cd "$(mktemp -d)" && npm i webgpu tsx && npx tsx <repo>/tools/ocio-bake/gpu-check.mts
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const tests: [string, () => Promise<void>][] = [];
const it = (n: string, f: () => Promise<void>) => tests.push([n, f]);
const expect = (v: number) => ({ toBeLessThan: (t: number) => { if (!(v < t)) throw new Error(`expected ${v} < ${t}`); } });
import {
  COMMON_WGSL, CDL_WGSL, INPUT_SPACES, VIEWS, applyViewCPU, falseColorWGSL, inputToACEScg,
  inputTransformWGSL, loadViewLut, type Vec3, applyAnalyticViewCPU, applyCDL,
} from '../../packages/core/src/color/index.ts';

// `webgpu` (Dawn for Node) is resolved from the current working directory, so it does not
// need to be a dependency of the repo.
const require = createRequire(process.cwd() + '/');
const { create, globals } = require('webgpu');
Object.assign(globalThis, globals);

const gpu = create([]);
let dev0: GPUDevice | undefined;
async function device(): Promise<GPUDevice> {
  if (!dev0) { const a = await gpu.requestAdapter(); dev0 = await a.requestDevice(); }
  return dev0!;
}

async function compile(dev: GPUDevice, code: string, label: string) {
  const m = dev.createShaderModule({ code, label });
  const info = await m.getCompilationInfo();
  const errs = info.messages.filter((x: GPUCompilationMessage) => x.type === 'error');
  if (errs.length) {
    console.log(code);
    throw new Error(`${label}: ${errs.map((e: GPUCompilationMessage) => `${e.lineNum}:${e.linePos} ${e.message}`).join('\n')}`);
  }
  return m;
}

async function runCompute(dev: GPUDevice, code: string, inputs: Vec3[], extra?: (layout: GPUBindGroupLayout) => GPUBindGroupEntry[]): Promise<Vec3[]> {
  const m = await compile(dev, code, 'k');
  const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
  const n = inputs.length;
  const inBuf = dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const arr = new Float32Array(n * 4);
  inputs.forEach((v, i) => arr.set(v, i * 4));
  dev.queue.writeBuffer(inBuf, 0, arr);
  const outBuf = dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const rd = dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }];
  if (extra) entries.push(...extra(pipe.getBindGroupLayout(0)));
  const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries });
  const enc = dev.createCommandEncoder();
  const p = enc.beginComputePass();
  p.setPipeline(pipe); p.setBindGroup(0, bg); p.dispatchWorkgroups(Math.ceil(n / 64)); p.end();
  enc.copyBufferToBuffer(outBuf, 0, rd, 0, n * 16);
  dev.queue.submit([enc.finish()]);
  await rd.mapAsync(GPUMapMode.READ);
  const o = new Float32Array(rd.getMappedRange().slice(0));
  rd.unmap();
  return inputs.map((_, i) => [o[i * 4], o[i * 4 + 1], o[i * 4 + 2]]);
}

const KERNEL = (call: string, extraDecl = '') => `
@group(0) @binding(0) var<storage, read> inp: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> outp: array<vec4f>;
${extraDecl}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x; if (i >= arrayLength(&inp)) { return; }
  let c = inp[i].xyz;
  outp[i] = vec4f(${call}, 1.0);
}`;

const fix = JSON.parse(readFileSync(new URL('./fixtures/input-spaces.json', import.meta.url), 'utf8'));

it('GPU: input transforms compile and match CPU', async () => {
  const dev = await device();
  for (const s of INPUT_SPACES) {
    const sp = fix.spaces.find((x: { id: string }) => x.id === s.id);
    const xs: Vec3[] = sp.input;
    const code = COMMON_WGSL + CDL_WGSL + falseColorWGSL('arri-like') + falseColorWGSL('ire') + inputTransformWGSL(s.id) + KERNEL('sl_input(c)');
    const out = await runCompute(dev, code, xs);
    let worst = 0;
    xs.forEach((x, i) => {
      const ref = inputToACEScg(s.id, x);
      const big = Math.max(...ref.map(Math.abs));
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out[i][k] - ref[k]) / (Math.max(Math.abs(ref[k]), 1) + 1e-2 * big));
    });
    console.log(`gpu ${s.id}: ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(2e-4);
  }
  for (const p of ['el-zone'] as const) await compile(dev, COMMON_WGSL + falseColorWGSL(p), p);
});

it('GPU: common helpers match CPU', async () => {
  const dev = await device();
  const xs: Vec3[] = [];
  for (let i = 0; i < 256; i++) xs.push([Math.random() * 2 - 0.2, Math.random() * 10, Math.random() * 0.01]);
  const rt = await runCompute(dev, COMMON_WGSL + KERNEL('sl_acescct_to_acescg(sl_acescg_to_acescct(c)) - c + sl_srgb_eotf(sl_srgb_oetf(c)) - c + sl_pq_oetf(sl_pq_eotf(sl_pq_oetf(c*100.0)))*0.0 + sl_hlg_inv_oetf(sl_hlg_oetf(c*0.1)) - c*0.1'), xs);
  for (const r of rt) for (const v of r) expect(Math.abs(v)).toBeLessThan(2e-4);
  const sc = await runCompute(dev, COMMON_WGSL + KERNEL('sl_view_srgb_clamp(c)'), xs);
  xs.forEach((x, i) => { const ref = applyAnalyticViewCPU('srgb-clamp', x); for (let k = 0; k < 3; k++) expect(Math.abs(sc[i][k] - ref[k])).toBeLessThan(1e-5); });
  const cdl = { slope: [1.1, 0.9, 1.2] as Vec3, offset: [0.01, -0.02, 0.0] as Vec3, power: [1.1, 0.9, 1.0] as Vec3, sat: 0.8 };
  const cd = await runCompute(dev, CDL_WGSL + KERNEL('sl_cdl(c, vec3f(1.1, 0.9, 1.2), vec3f(0.01, -0.02, 0.0), vec3f(1.1, 0.9, 1.0), 0.8)'), xs.map((x) => [x[0] * 0.5, x[1] * 0.1, x[2]] as Vec3));
  xs.forEach((x, i) => { const ref = applyCDL([x[0] * 0.5, x[1] * 0.1, x[2]], cdl); for (let k = 0; k < 3; k++) expect(Math.abs(cd[i][k] - ref[k])).toBeLessThan(1e-5); });
});

it('GPU: LUT texture sampling matches applyViewCPU', async () => {
  const dev = await device();
  for (const v of VIEWS) {
    const lut = await loadViewLut(v.id);
    const n = lut.size;
    const tex = dev.createTexture({ size: [n, n, n], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: tex }, lut.data, { bytesPerRow: n * 8, rowsPerImage: n }, [n, n, n]);
    const samp = dev.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
    const xs: Vec3[] = [];
    for (let i = 0; i < 2000; i++) xs.push([0.18 * 2 ** (Math.random() * 16 - 8), 0.18 * 2 ** (Math.random() * 16 - 8), 0.18 * 2 ** (Math.random() * 16 - 8)]);
    const out = await runCompute(dev, COMMON_WGSL + KERNEL(`textureSampleLevel(lut, lsamp, sl_lut_coord(c, ${n}.0), 0.0).rgb`,
      '@group(0) @binding(2) var lut: texture_3d<f32>;\n@group(0) @binding(3) var lsamp: sampler;'), xs,
      () => [{ binding: 2, resource: tex.createView() }, { binding: 3, resource: samp }]);
    let worst = 0;
    xs.forEach((x, i) => { const ref = applyViewCPU(lut, x); for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out[i][k] - ref[k])); });
    const ex = await runCompute(dev, COMMON_WGSL + KERNEL(`sl_lut_trilinear(lut, c)`,
      '@group(0) @binding(2) var lut: texture_3d<f32>;'), xs,
      () => [{ binding: 2, resource: tex.createView() }]);
    let worstEx = 0;
    xs.forEach((x, i) => { const ref = applyViewCPU(lut, x); for (let k = 0; k < 3; k++) worstEx = Math.max(worstEx, Math.abs(ex[i][k] - ref[k])); });
    console.log(`gpu lut ${v.id}: max abs diff hw-filter ${worst.toExponential(2)}  textureLoad-trilinear ${worstEx.toExponential(2)}`);
    expect(worstEx).toBeLessThan(1e-5);
    expect(worst).toBeLessThan(5e-3);
  }
});

for (const [n, f] of tests) { try { await f(); console.log('PASS', n); } catch (e) { console.log('FAIL', n, e); } }
process.exit(0);
