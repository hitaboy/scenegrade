// SPDX-License-Identifier: Apache-2.0
// Packs a Grade into the flat buffers the GPU reads (and the CPU reference evaluates), so both
// interpret exactly the same numbers.
//
// The GPU side is an "interpreter" shader: one fixed WGSL function loops over the packed nodes and
// branches on per-node flags (uniform control flow, so the branches are free). Changing the grade —
// even its structure — never recompiles a pipeline; it only rewrites a storage buffer and a small
// curve texture.

import { PRIMARIES, adapt, inv, mul, rgbToXyz, type M3 } from '../gpu/matrices.js';
import { CURVE_N, bakeCurve } from './curves.js';
import {
  NEUTRAL_KELVIN,
  isIdentityDeltaCurve,
  isIdentityNode,
  isIdentityRgbCurve,
  nodeIs,
  type Grade,
  type GradeNode,
} from './model.js';

export const F = {
  LINEAR: 1,
  PRIMARIES: 2,
  LOG_WHEELS: 4,
  CDL: 8,
  CURVE_R: 16,
  CURVE_G: 32,
  CURVE_B: 64,
  CURVE_Y: 128,
  HUE_HUE: 256,
  HUE_SAT: 512,
  HUE_LUM: 1024,
  LUM_SAT: 2048,
  SAT_SAT: 4096,
  SAT_HUE: 8192,
} as const;
/** Flags that need the ACEScct domain. */
export const F_LOG = 0x3ffe;
/** Flags handled by the HSL stage. */
export const F_HSL = F.HUE_HUE | F.HUE_SAT | F.HUE_LUM | F.LUM_SAT | F.SAT_SAT | F.SAT_HUE;

/** ACEScct range a node output is clamped to (≈ −0.1 … 4e7 linear), keeps f32 finite. */
export const CCT_MIN = -1;
export const CCT_MAX = 2;
/** vec4 slots per node in the parameter buffer. */
export const NODE_VEC4 = 16;
/** Curve rows per node: R, G, B, Y, hue/hue, hue/sat, hue/lum, lum/sat, sat/sat. */
export const CURVE_ROWS = 9;
/** Transition width of the log wheel ranges (ACEScct). */
export const LOG_WHEEL_SOFTNESS = 0.1;

export interface PackedGrade {
  /** vec4 array: header + NODE_VEC4 per active node. */
  params: Float32Array;
  /** r32float texture data, CURVE_N wide, `rows` high. */
  curves: Float32Array;
  rows: number;
  nodeCount: number;
}

export const EMPTY_PACKED: PackedGrade = {
  params: new Float32Array(4),
  curves: new Float32Array(CURVE_N),
  rows: 1,
  nodeCount: 0,
};

// ---------------------------------------------------------------------------------------------
// White balance
// ---------------------------------------------------------------------------------------------

/** CIE 1931 xy of a Planckian radiator (Kim et al. 2002 cubic fit, 1667–25000 K). */
export function planckianXY(T: number): [number, number] {
  const t = Math.min(25000, Math.max(1667, T));
  const x =
    t <= 4000
      ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  const y =
    t <= 2222
      ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

const xyToUv = ([x, y]: [number, number]): [number, number] => {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (6 * y) / d];
};
const uvToXy = ([u, v]: [number, number]): [number, number] => {
  const d = 2 * u - 8 * v + 4;
  return [(3 * u) / d, (2 * v) / d];
};

/** Illuminant chromaticity for a temperature and a tint (±1 ≈ ±0.02 Duv, + is greener light). */
export function illuminantXY(T: number, tint: number): [number, number] {
  if (tint === 0) return planckianXY(T);
  const uv = xyToUv(planckianXY(T));
  const a = xyToUv(planckianXY(T - 10));
  const b = xyToUv(planckianXY(T + 10));
  const du = b[0] - a[0];
  const dv = b[1] - a[1];
  const len = Math.hypot(du, dv) || 1;
  // Normal pointing to +v (above the locus, towards green).
  let nu = -dv / len;
  let nv = du / len;
  if (nv < 0) {
    nu = -nu;
    nv = -nv;
  }
  const duv = tint * 0.02;
  return uvToXy([uv[0] + nu * duv, uv[1] + nv * duv]);
}

const AP1_TO_XYZ = rgbToXyz(PRIMARIES.ap1);
const XYZ_TO_AP1 = inv(AP1_TO_XYZ);
const IDENTITY: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** ACEScg white-balance matrix: adapts from the assumed illuminant to the neutral reference. */
export function whiteBalanceMatrix(temperature: number, tint: number): M3 {
  if (temperature === NEUTRAL_KELVIN && tint === 0) return [...IDENTITY] as M3;
  const src = illuminantXY(temperature, tint);
  const dst = planckianXY(NEUTRAL_KELVIN);
  return mul(XYZ_TO_AP1, mul(adapt(src, dst), AP1_TO_XYZ));
}

/** The node's full linear stage (mixer · white balance · exposure), row-major. */
export function linearMatrix(n: GradeNode): M3 {
  const g = 2 ** n.linear.exposure;
  const wb = whiteBalanceMatrix(n.linear.temperature, n.linear.tint);
  const m = mul(n.linear.mixer as M3, wb);
  return m.map((v) => v * g) as M3;
}

// ---------------------------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------------------------

export function nodeFlags(n: GradeNode): number {
  const c = n.curves;
  let f = 0;
  if (nodeIs.linear(n)) f |= F.LINEAR;
  if (nodeIs.primaries(n)) f |= F.PRIMARIES;
  if (nodeIs.logWheels(n)) f |= F.LOG_WHEELS;
  if (nodeIs.cdl(n)) f |= F.CDL;
  if (!isIdentityRgbCurve(c.r)) f |= F.CURVE_R;
  if (!isIdentityRgbCurve(c.g)) f |= F.CURVE_G;
  if (!isIdentityRgbCurve(c.b)) f |= F.CURVE_B;
  if (!isIdentityRgbCurve(c.y)) f |= F.CURVE_Y;
  if (!isIdentityDeltaCurve(c.hueHue)) f |= F.HUE_HUE;
  if (!isIdentityDeltaCurve(c.hueSat)) f |= F.HUE_SAT;
  if (!isIdentityDeltaCurve(c.hueLum)) f |= F.HUE_LUM;
  if (!isIdentityDeltaCurve(c.lumSat)) f |= F.LUM_SAT;
  if (!isIdentityDeltaCurve(c.satSat)) f |= F.SAT_SAT;
  if (nodeIs.satHue(n)) f |= F.SAT_HUE;
  return f;
}

export function packGrade(g: Grade | null | undefined): PackedGrade {
  if (!g || !g.enabled) return EMPTY_PACKED;
  const nodes = g.nodes.filter((n) => !isIdentityNode(n));
  if (!nodes.length) return EMPTY_PACKED;
  const params = new Float32Array(4 + nodes.length * NODE_VEC4 * 4);
  const rows = nodes.length * CURVE_ROWS;
  const curves = new Float32Array(CURVE_N * rows);
  params[0] = nodes.length;
  nodes.forEach((n, k) => {
    const o = 4 + k * NODE_VEC4 * 4;
    const set = (slot: number, x: number, y: number, z: number, w: number) => {
      params.set([x, y, z, w], o + slot * 4);
    };
    const flags = nodeFlags(n);
    set(0, flags, n.mix, k * CURVE_ROWS, LOG_WHEEL_SOFTNESS);
    const m = flags & F.LINEAR ? linearMatrix(n) : IDENTITY;
    set(1, m[0], m[1], m[2], 0);
    set(2, m[3], m[4], m[5], 0);
    set(3, m[6], m[7], m[8], 0);
    const p = n.primaries;
    const lift = [0, 1, 2].map((i) => p.lift[i] + p.lift[3]);
    const gam = [0, 1, 2].map((i) => 2 ** -(p.gamma[i] + p.gamma[3]));
    const gain = [0, 1, 2].map((i) => p.gain[i] * p.gain[3]);
    const off = [0, 1, 2].map((i) => p.offset[i] + p.offset[3]);
    set(4, lift[0], lift[1], lift[2], p.contrast);
    set(5, gam[0], gam[1], gam[2], p.pivot);
    set(6, gain[0], gain[1], gain[2], p.saturation);
    set(7, off[0], off[1], off[2], p.hue * 2 * Math.PI);
    const w = n.logWheels;
    set(8, ...w.shadows, w.lowRange);
    set(9, ...w.midtones, w.highRange);
    set(10, ...w.highlights, 0);
    const c = n.cdl;
    set(11, ...c.slope, c.saturation);
    set(12, ...c.offset, 0);
    set(13, ...c.power, 0);
    const base = k * CURVE_ROWS * CURVE_N;
    const cv = n.curves;
    bakeCurve(cv.r, 'tone', curves, base + 0 * CURVE_N);
    bakeCurve(cv.g, 'tone', curves, base + 1 * CURVE_N);
    bakeCurve(cv.b, 'tone', curves, base + 2 * CURVE_N);
    bakeCurve(cv.y, 'tone', curves, base + 3 * CURVE_N);
    bakeCurve(cv.hueHue, 'periodic', curves, base + 4 * CURVE_N);
    bakeCurve(cv.hueSat, 'periodic', curves, base + 5 * CURVE_N);
    bakeCurve(cv.hueLum, 'periodic', curves, base + 6 * CURVE_N);
    bakeCurve(cv.lumSat, 'delta', curves, base + 7 * CURVE_N);
    bakeCurve(cv.satSat, 'delta', curves, base + 8 * CURVE_N);
  });
  return { params, curves, rows, nodeCount: nodes.length };
}
