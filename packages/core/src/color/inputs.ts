// SPDX-License-Identifier: Apache-2.0
// Analytic input transforms: encoded source RGB -> linear ACEScg (AP1, D60).
// The op chains (and every constant/matrix) are extracted from OpenColorIO by
// tools/ocio-bake/bake.py into generated.ts; this module evaluates them on the CPU and
// emits equivalent WGSL.

import { INPUT_SPACE_INFO, INPUT_STAGES, type Stage } from './generated.js';
import { type Vec3, mul3, wf, wgslMat3 } from './math.js';
import { moncurveParams } from './transfer.js';

export interface InputSpace {
  id: string;
  label: string;
  family: 'ACES' | 'Scene-linear' | 'Camera log' | 'Display';
  ocioName: string;
  isLog: boolean;
}

export const INPUT_SPACES: InputSpace[] = INPUT_SPACE_INFO.map((s) => ({ ...s }));

export function findInputSpace(id: string): InputSpace | undefined {
  return INPUT_SPACES.find((s) => s.id === id);
}

function stagesOf(id: string): Stage[] {
  const st = INPUT_STAGES[id];
  if (!st) throw new Error(`Unknown input colour space: ${id}`);
  return st;
}

// ---- closed-form curves for the ops OCIO implements as 1D LUTs ------------------------------
const APPLE = {
  R0: -0.05641088,
  Rt: 0.01,
  c: 47.28711236,
  b: 0.00964052,
  g: 0.08550479,
  beta: 0.69336945,
};
const APPLE_PT = APPLE.c * (APPLE.Rt - APPLE.R0) ** 2;
const ACESCC_TOE = (9.72 - 15) / 17.52;

function logcamDerived(s: Extract<Stage, { op: 'logcam' }>) {
  const linAtBreak = s.linSlope * s.linBreak + s.linOffset;
  const logBreak = (s.logSlope * Math.log(linAtBreak)) / Math.log(s.base) + s.logOffset;
  const linearSlope = s.linearSlope ?? (s.logSlope * s.linSlope) / (linAtBreak * Math.log(s.base));
  const linearOffset = logBreak - linearSlope * s.linBreak;
  return { logBreak, linearSlope, linearOffset };
}

function curve1(s: Stage, x: number): number {
  switch (s.op) {
    case 'logcam': {
      const d = logcamDerived(s);
      return x <= d.logBreak
        ? (x - d.linearOffset) / d.linearSlope
        : (s.base ** ((x - s.logOffset) / s.logSlope) - s.linOffset) / s.linSlope;
    }
    case 'explin': {
      const p = moncurveParams(s.gamma, s.offset);
      const a = s.mirror ? Math.abs(x) : x;
      const y = a >= p.eBreak ? ((a + s.offset) / (1 + s.offset)) ** s.gamma : a * p.slope;
      return s.mirror && x < 0 ? -y : y;
    }
    case 'pow':
      if (s.style === 'mirror') return x < 0 ? -((-x) ** s.gamma) : x ** s.gamma;
      if (s.style === 'clamp') return Math.max(x, 0) ** s.gamma;
      return x < 0 ? x : x ** s.gamma;
    case 'clampMin':
      return Math.max(x, s.v);
    case 'acescc': {
      const c = Math.min(Math.max(x, s.min), s.max);
      return c < ACESCC_TOE ? (2 ** (c * 17.52 - 9.72) - 2 ** -16) * 2 : 2 ** (c * 17.52 - 9.72);
    }
    case 'applelog':
      if (x >= APPLE_PT) return 2 ** ((x - APPLE.beta) / APPLE.g) - APPLE.b;
      return x >= 0 ? Math.sqrt(x / APPLE.c) + APPLE.R0 : APPLE.R0;
    case 'clog2': {
      const c = Math.min(Math.max(x, 0), 1);
      return (
        0.9 *
        (c < 0.092864125
          ? -(10 ** ((0.092864125 - c) / 0.24136077) - 1) / 87.09937546
          : (10 ** ((c - 0.092864125) / 0.24136077) - 1) / 87.09937546)
      );
    }
    case 'clog3': {
      const c = Math.min(Math.max(x, 0), 1);
      let y: number;
      if (c < 0.097465473) y = -(10 ** ((0.12783901 - c) / 0.36726845) - 1) / 14.98325;
      else if (c <= 0.15277891) y = (c - 0.12512219) / 1.9754798;
      else y = (10 ** ((c - 0.12240537) / 0.36726845) - 1) / 14.98325;
      return 0.9 * y;
    }
    default:
      throw new Error(`not a per-channel op: ${s.op}`);
  }
}

/** CPU reference: encoded `rgb` in input space `id` -> linear ACEScg. */
export function inputToACEScg(id: string, rgb: Vec3): Vec3 {
  let c: Vec3 = [rgb[0], rgb[1], rgb[2]];
  for (const s of stagesOf(id)) {
    if (s.op === 'matrix') c = mul3(s.m, c);
    else c = [curve1(s, c[0]), curve1(s, c[1]), curve1(s, c[2])];
  }
  return c;
}

// ---- WGSL --------------------------------------------------------------------------------------
const V = (x: number) => `vec3f(${wf(x)})`;
/** exp2(y*log2(b)) for constant positive base b. */
const powB = (base: number, e: string) => `exp2((${e}) * ${wf(Math.log2(base))})`;

function stageWGSL(s: Stage): string {
  switch (s.op) {
    case 'matrix':
      return `c = ${wgslMat3(s.m)} * c;`;
    case 'logcam': {
      const d = logcamDerived(s);
      const log = `(${powB(s.base, `(c - ${wf(s.logOffset)}) / ${wf(s.logSlope)}`)} - ${wf(s.linOffset)}) / ${wf(s.linSlope)}`;
      const lin = `(c - ${wf(d.linearOffset)}) / ${wf(d.linearSlope)}`;
      return `c = select(${log}, ${lin}, c <= ${V(d.logBreak)});`;
    }
    case 'explin': {
      const p = moncurveParams(s.gamma, s.offset);
      const a = s.mirror ? 'abs(c)' : 'c';
      const body = `select(a * ${wf(p.slope)}, sl_in_pow(max((a + ${wf(s.offset)}) / ${wf(1 + s.offset)}, vec3f(0.0)), ${wf(s.gamma)}), a >= ${V(p.eBreak)})`;
      return `{ let a = ${a}; c = ${s.mirror ? `sign(c) * ${body}` : body}; }`;
    }
    case 'pow':
      if (s.style === 'mirror') return `c = sign(c) * sl_in_pow(abs(c), ${wf(s.gamma)});`;
      if (s.style === 'clamp') return `c = sl_in_pow(max(c, vec3f(0.0)), ${wf(s.gamma)});`;
      return `c = select(sl_in_pow(c, ${wf(s.gamma)}), c, c < vec3f(0.0));`;
    case 'clampMin':
      return `c = max(c, ${V(s.v)});`;
    case 'acescc':
      return (
        `c = clamp(c, ${V(s.min)}, ${V(s.max)}); ` +
        `{ let e = exp2(c * 17.52 - 9.72); c = select(e, (e - ${wf(2 ** -16)}) * 2.0, c < ${V(ACESCC_TOE)}); }`
      );
    case 'applelog':
      return (
        `c = select(select(${V(APPLE.R0)}, sqrt(max(c, vec3f(0.0)) / ${wf(APPLE.c)}) + ${wf(APPLE.R0)}, c >= vec3f(0.0)), ` +
        `exp2((c - ${wf(APPLE.beta)}) / ${wf(APPLE.g)}) - ${wf(APPLE.b)}, c >= ${V(APPLE_PT)});`
      );
    case 'clog2':
      return (
        `c = clamp(c, vec3f(0.0), vec3f(1.0)); ` +
        `c = 0.9 * select((${powB(10, `(c - 0.092864125) / 0.24136077`)} - 1.0) / 87.09937546, ` +
        `-(${powB(10, `(0.092864125 - c) / 0.24136077`)} - 1.0) / 87.09937546, c < vec3f(0.092864125));`
      );
    case 'clog3':
      return (
        `c = clamp(c, vec3f(0.0), vec3f(1.0)); ` +
        `c = 0.9 * select(select((${powB(10, `(c - 0.12240537) / 0.36726845`)} - 1.0) / 14.98325, (c - 0.12512219) / 1.9754798, c <= vec3f(0.15277891)), ` +
        `-(${powB(10, `(0.12783901 - c) / 0.36726845`)} - 1.0) / 14.98325, c < vec3f(0.097465473));`
      );
  }
}

/**
 * WGSL source defining `fn sl_input(c: vec3f) -> vec3f` (encoded -> linear ACEScg) for input
 * space `id`. Self-contained (only uses its own `sl_in_*` helper), no bindings; safe to
 * concatenate with COMMON_WGSL.
 */
export function inputTransformWGSL(id: string): string {
  const stages = stagesOf(id);
  const body = stages.map((s) => `  ${stageWGSL(s)}`).join('\n');
  return `// input transform: ${id} (${findInputSpace(id)?.ocioName ?? id}) -> ACEScg
fn sl_in_pow(x: vec3f, g: f32) -> vec3f {
  return select(vec3f(0.0), exp2(g * log2(max(x, vec3f(1e-30)))), x > vec3f(0.0));
}
fn sl_input(c_in: vec3f) -> vec3f {
  var c = c_in;
${body || '  // identity'}
  return c;
}
`;
}
