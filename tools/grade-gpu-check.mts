// SPDX-License-Identifier: Apache-2.0
// GPU validation of the grade interpreter (GRADE_WGSL) against applyGradeCPU, with Dawn.
// Runs random grades exercising every operation over random scene values.
//   cd "$(mktemp -d)" && npm i webgpu tsx && npx tsx <repo>/tools/grade-gpu-check.mts
import { createRequire } from 'node:module';
import { COMMON_WGSL, CDL_WGSL, linToACEScct } from '../packages/core/src/color/index.ts';
import {
  CURVE_N,
  GRADE_BINDINGS_WGSL,
  GRADE_WGSL,
  applyGradeCPU,
  defaultGrade,
  defaultNode,
  packGrade,
  type Grade,
  type V3,
} from '../packages/core/src/grade/index.ts';

const require = createRequire(process.cwd() + '/');
const { create, globals } = require('webgpu');
Object.assign(globalThis, globals);
// Keep the GPU object referenced: if it is garbage-collected Dawn crashes.
const gpu = create([]);
(globalThis as Record<string, unknown>).__gpu = gpu;
const adapter = await gpu.requestAdapter();
const dev: GPUDevice = await adapter.requestDevice();

let seed = 1234;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const r = (lo: number, hi: number) => lo + (hi - lo) * rnd();
const pts = (n: number, lo: number, hi: number, sortX = true): [number, number][] => {
  const p = Array.from({ length: n }, () => [rnd(), r(lo, hi)] as [number, number]);
  return sortX ? p.sort((a, b) => a[0] - b[0]) : p;
};

function randomGrade(): Grade {
  const g = defaultGrade();
  g.nodes = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
    const n = defaultNode();
    if (rnd() < 0.6) {
      n.linear.exposure = r(-2, 2);
      n.linear.temperature = r(2500, 12000);
      n.linear.tint = r(-1, 1);
      n.linear.mixer = [
        1 + r(-0.2, 0.2),
        r(-0.1, 0.1),
        r(-0.1, 0.1),
        r(-0.1, 0.1),
        1,
        r(-0.1, 0.1),
        0,
        r(-0.1, 0.1),
        1,
      ];
    }
    if (rnd() < 0.7) {
      const p = n.primaries;
      p.lift = [r(-0.05, 0.05), r(-0.05, 0.05), r(-0.05, 0.05), r(-0.05, 0.05)];
      p.gamma = [r(-0.3, 0.3), r(-0.3, 0.3), r(-0.3, 0.3), r(-0.3, 0.3)];
      p.gain = [r(0.8, 1.2), r(0.8, 1.2), r(0.8, 1.2), r(0.8, 1.2)];
      p.offset = [r(-0.05, 0.05), r(-0.05, 0.05), r(-0.05, 0.05), r(-0.05, 0.05)];
      p.contrast = r(0.7, 1.5);
      p.pivot = r(0.35, 0.45);
      p.saturation = r(0, 2);
      p.hue = r(-0.5, 0.5);
    }
    if (rnd() < 0.5) {
      n.logWheels.shadows = [r(-0.05, 0.05), r(-0.05, 0.05), r(-0.05, 0.05)];
      n.logWheels.midtones = [r(-0.05, 0.05), r(-0.05, 0.05), r(-0.05, 0.05)];
      n.logWheels.highlights = [r(-0.05, 0.05), r(-0.05, 0.05), r(-0.05, 0.05)];
    }
    if (rnd() < 0.4) {
      n.cdl = {
        enabled: true,
        slope: [r(0.8, 1.2), r(0.8, 1.2), r(0.8, 1.2)],
        offset: [r(-0.05, 0.05), r(-0.05, 0.05), r(-0.05, 0.05)],
        power: [r(0.8, 1.2), r(0.8, 1.2), r(0.8, 1.2)],
        saturation: r(0.5, 1.5),
      };
    }
    if (rnd() < 0.6) {
      n.curves.r = [[0, 0], ...pts(2, 0.1, 0.9), [1, 1]];
      n.curves.y = [[0, r(0, 0.1)], ...pts(3, 0.1, 0.9), [1, r(0.9, 1)]];
    }
    if (rnd() < 0.6) {
      n.curves.hueHue = pts(3, -0.1, 0.1);
      n.curves.hueSat = pts(3, -0.5, 0.5);
      n.curves.hueLum = pts(2, -0.05, 0.05);
      n.curves.lumSat = pts(2, -0.5, 0.5);
      n.curves.satSat = pts(2, -0.5, 0.5);
    }
    n.mix = rnd() < 0.3 ? r(0, 1) : 1;
    return n;
  });
  return g;
}

const code =
  COMMON_WGSL +
  CDL_WGSL +
  GRADE_BINDINGS_WGSL +
  GRADE_WGSL +
  /* wgsl */ `
@group(0) @binding(0) var<storage, read> inp: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> outp: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x; if (i >= arrayLength(&inp)) { return; }
  outp[i] = vec4f(sl_grade(inp[i].xyz), 1.0);
}`;
const module = dev.createShaderModule({ code });
const info = await module.getCompilationInfo();
const errs = info.messages.filter((m: GPUCompilationMessage) => m.type === 'error');
if (errs.length) {
  console.log(
    errs.map((e: GPUCompilationMessage) => `${e.lineNum}:${e.linePos} ${e.message}`).join('\n'),
  );
  process.exit(1);
}
const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });

async function gpuGrade(g: Grade, xs: V3[]): Promise<V3[]> {
  const p = packGrade(g);
  const n = xs.length;
  const inBuf = dev.createBuffer({
    size: n * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const arr = new Float32Array(n * 4);
  xs.forEach((x, i) => arr.set(x, i * 4));
  dev.queue.writeBuffer(inBuf, 0, arr);
  const outBuf = dev.createBuffer({
    size: n * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const rd = dev.createBuffer({
    size: n * 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const pb = dev.createBuffer({
    size: Math.max(16, p.params.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  dev.queue.writeBuffer(pb, 0, p.params);
  const tex = dev.createTexture({
    size: [CURVE_N, p.rows],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  dev.queue.writeTexture(
    { texture: tex },
    p.curves,
    { bytesPerRow: CURVE_N * 4, rowsPerImage: p.rows },
    [CURVE_N, p.rows],
  );
  const bg = dev.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: inBuf } },
      { binding: 1, resource: { buffer: outBuf } },
      { binding: 7, resource: { buffer: pb } },
      { binding: 8, resource: tex.createView() },
    ],
  });
  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(Math.ceil(n / 64));
  pass.end();
  enc.copyBufferToBuffer(outBuf, 0, rd, 0, n * 16);
  dev.queue.submit([enc.finish()]);
  await rd.mapAsync(GPUMapMode.READ);
  const o = new Float32Array(rd.getMappedRange().slice(0));
  rd.unmap();
  return xs.map((_, i) => [o[i * 4], o[i * 4 + 1], o[i * 4 + 2]]);
}

const ONLY = process.env.ONLY;
let worst = 0;
let fails = 0;
let shown = 0;
for (let t = 0; t < 200; t++) {
  const g = randomGrade();
  if (ONLY) {
    const d = defaultNode();
    for (const n of g.nodes)
      for (const k of ['linear', 'primaries', 'logWheels', 'cdl', 'curves'] as const)
        if (k !== ONLY) (n as Record<string, unknown>)[k] = d[k];
  }
  const xs: V3[] = Array.from(
    { length: 512 },
    () => [0.18 * 2 ** r(-8, 6), 0.18 * 2 ** r(-8, 6), 0.18 * 2 ** r(-8, 6)] as V3,
  );
  xs.push([0, 0, 0], [0.18, 0.18, 0.18], [-0.001, 0.01, 0.1]);
  const gpu = await gpuGrade(g, xs);
  const p = packGrade(g);
  xs.forEach((x, i) => {
    const ref = applyGradeCPU(p, x);
    for (let k = 0; k < 3; k++) {
      // Error in ACEScct units (a 10-bit code value is ~1e-3; f32 and hue-branch flips near
      // max(R,G,B) ties give a few 1e-4).
      const e = Math.abs(linToACEScct(gpu[i][k]) - linToACEScct(ref[k]));
      if (!Number.isFinite(gpu[i][k]) && Number.isFinite(ref[k])) fails++;
      if ((e > 5e-4 || !Number.isFinite(gpu[i][k])) && shown++ < 3)
        console.log(
          'x',
          x,
          'gpu',
          gpu[i],
          'cpu',
          ref,
          JSON.stringify(g.nodes.map((n) => ({ ...n, curves: undefined }))).slice(0, 600),
        );
      if (Number.isFinite(e)) worst = Math.max(worst, e);
    }
  });
}
console.log(
  `grade GPU vs CPU: worst ACEScct error ${worst.toExponential(2)}, non-finite mismatches ${fails}`,
);
process.exit(worst < 5e-4 && fails === 0 ? 0 : 1);
