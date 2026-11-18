// SPDX-License-Identifier: Apache-2.0
// Transfer functions (CPU) and the shared WGSL helper library (COMMON_WGSL).
// Constants follow what OpenColorIO evaluates for the ACES studio config, so the CPU
// reference, the WGSL and the OCIO fixtures agree.

import { MATRICES, SHAPER_MAX, SHAPER_MIN } from './generated.js';
import { type Vec3, wf, wgslMat3 } from './math.js';

// ---------------------------------------------------------------------------
// ACEScct (S-2016-001)
// ---------------------------------------------------------------------------
const CCT_A = 10.5402377416545;
const CCT_B = 0.0729055341958355;
const CCT_LIN_BREAK = 0.0078125;
const CCT_LOG_BREAK = 0.155251141552511;

export function linToACEScct(x: number): number {
  return x <= CCT_LIN_BREAK ? CCT_A * x + CCT_B : (Math.log2(x) + 9.72) / 17.52;
}
export function acesCctToLin(y: number): number {
  return y <= CCT_LOG_BREAK ? (y - CCT_B) / CCT_A : 2 ** (y * 17.52 - 9.72);
}
export const acescgToACEScct = (c: Vec3): Vec3 => [
  linToACEScct(c[0]),
  linToACEScct(c[1]),
  linToACEScct(c[2]),
];
export const acescctToACEScg = (c: Vec3): Vec3 => [
  acesCctToLin(c[0]),
  acesCctToLin(c[1]),
  acesCctToLin(c[2]),
];

// ---------------------------------------------------------------------------
// OCIO "ExponentWithLinear" (moncurve) — sRGB piecewise curve with exact C1 continuity.
// ---------------------------------------------------------------------------
export function moncurveParams(gamma: number, offset: number) {
  const eBreak = offset / (gamma - 1); // encoded-side break
  const lBreak = ((eBreak + offset) / (1 + offset)) ** gamma; // linear-side break
  return { eBreak, lBreak, slope: lBreak / eBreak };
}
const SRGB = moncurveParams(2.4, 0.055);

/** sRGB EOTF (signal -> linear), sign-preserving / extended range. */
export function srgbEotf(v: number): number {
  const a = Math.abs(v);
  const y = a >= SRGB.eBreak ? ((a + 0.055) / 1.055) ** 2.4 : a * SRGB.slope;
  return v < 0 ? -y : y;
}
/** sRGB inverse EOTF (linear -> signal), sign-preserving / extended range. */
export function srgbOetf(v: number): number {
  const a = Math.abs(v);
  const y = a >= SRGB.lBreak ? 1.055 * a ** (1 / 2.4) - 0.055 : a / SRGB.slope;
  return v < 0 ? -y : y;
}
export const powMirror = (v: number, g: number) => (v < 0 ? -((-v) ** g) : v ** g);

// ---------------------------------------------------------------------------
// PQ (SMPTE ST 2084) and HLG (BT.2100)
// ---------------------------------------------------------------------------
const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;

/** PQ signal -> absolute nits (cd/m^2). Sign-preserving. */
export function pqEotf(e: number): number {
  const ep = Math.abs(e) ** (1 / PQ_M2);
  const y = 10000 * (Math.max(ep - PQ_C1, 0) / (PQ_C2 - PQ_C3 * ep)) ** (1 / PQ_M1);
  return e < 0 ? -y : y;
}
/** Absolute nits -> PQ signal. Sign-preserving. */
export function pqOetf(nits: number): number {
  const yp = (Math.abs(nits) / 10000) ** PQ_M1;
  const e = ((PQ_C1 + PQ_C2 * yp) / (1 + PQ_C3 * yp)) ** PQ_M2;
  return nits < 0 ? -e : e;
}

const HLG_A = 0.17883277;
const HLG_B = 1 - 4 * HLG_A;
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);
/** HLG OETF: scene light E in [0,1] -> signal. Sign-preserving. */
export function hlgOetf(e: number): number {
  const a = Math.abs(e);
  const y = a <= 1 / 12 ? Math.sqrt(3 * a) : HLG_A * Math.log(12 * a - HLG_B) + HLG_C;
  return e < 0 ? -y : y;
}
/** HLG inverse OETF: signal -> scene light E in [0,1]. Sign-preserving. */
export function hlgInvOetf(v: number): number {
  const a = Math.abs(v);
  const y = a <= 0.5 ? (a * a) / 3 : (Math.exp((a - HLG_C) / HLG_A) + HLG_B) / 12;
  return v < 0 ? -y : y;
}
export const HLG_PEAK_NITS = 1000;
export const HLG_SYSTEM_GAMMA = 1.2;

// Luminance weights (row 1 of RGB->XYZ).
export const LUMA_AP1: Vec3 = [
  MATRICES.AP1_TO_XYZ_D60[3],
  MATRICES.AP1_TO_XYZ_D60[4],
  MATRICES.AP1_TO_XYZ_D60[5],
];
export const LUMA_709: Vec3 = [
  MATRICES.REC709_TO_XYZ[3],
  MATRICES.REC709_TO_XYZ[4],
  MATRICES.REC709_TO_XYZ[5],
];
export const LUMA_2020: Vec3 = [
  MATRICES.REC2020_TO_XYZ[3],
  MATRICES.REC2020_TO_XYZ[4],
  MATRICES.REC2020_TO_XYZ[5],
];
export const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** BT.2100 HLG reference display: signal -> nits (Lw = 1000, gamma 1.2, Lb = 0, Rec.2020 luma). */
export function hlgToNits(s: Vec3): Vec3 {
  const e: Vec3 = [hlgInvOetf(s[0]), hlgInvOetf(s[1]), hlgInvOetf(s[2])];
  const ys = Math.max(dot3(e, LUMA_2020), 1e-12);
  const k = HLG_PEAK_NITS * ys ** (HLG_SYSTEM_GAMMA - 1);
  return [e[0] * k, e[1] * k, e[2] * k];
}

// ---------------------------------------------------------------------------
// COMMON_WGSL
// ---------------------------------------------------------------------------
const M = MATRICES;
const v3 = (v: Vec3) => `vec3f(${wf(v[0])}, ${wf(v[1])}, ${wf(v[2])})`;

/**
 * Shared WGSL helpers. All identifiers are prefixed `sl_` / `SL_` except the colour matrices,
 * which are `const mat3x3f` named `<SRC>_TO_<DST>` and are used as `M * rgb`.
 * AP1_TO_XYZ / XYZ_TO_AP1 are D65-adapted with the CAT OpenColorIO uses in the ACES (Bradford)
 * studio config (i.e. ACEScg -> CIE XYZ D65 display reference). AP1_TO_XYZ_D60 is the native,
 * unadapted ACES matrix (its middle row = ACEScg luminance weights, used by sl_luma_ap1).
 */
export const COMMON_WGSL = /* wgsl */ `
// ---- scenelinear common colour library (constants from OpenColorIO, see generated.ts) ----
${Object.entries(M)
  .map(([k, m]) => `const ${k} = ${wgslMat3(m)};`)
  .join('\n')}

const SL_SHAPER_MIN: f32 = ${wf(SHAPER_MIN)};
const SL_SHAPER_MAX: f32 = ${wf(SHAPER_MAX)};

fn sl_acescg_to_acescct(c: vec3f) -> vec3f {
  let lg = (log2(max(c, vec3f(1e-30))) + 9.72) / 17.52;
  return select(lg, ${wf(CCT_A)} * c + ${wf(CCT_B)}, c <= vec3f(${wf(CCT_LIN_BREAK)}));
}
fn sl_acescct_to_acescg(c: vec3f) -> vec3f {
  return select(exp2(c * 17.52 - 9.72), (c - ${wf(CCT_B)}) / ${wf(CCT_A)}, c <= vec3f(${wf(CCT_LOG_BREAK)}));
}

// Normalised 3D-LUT texture coordinate for the baked view LUTs (ACEScct shaper, texel centres).
fn sl_lut_coord(acescg: vec3f, size: f32) -> vec3f {
  let v = clamp((sl_acescg_to_acescct(acescg) - SL_SHAPER_MIN) / (SL_SHAPER_MAX - SL_SHAPER_MIN), vec3f(0.0), vec3f(1.0));
  return (v * (size - 1.0) + 0.5) / size;
}

// Exact trilinear lookup of a baked view LUT with textureLoad (full-precision weights; hardware
// linear filtering quantises weights to ~8 bits on many GPUs, ~1e-3 error in steep regions).
fn sl_lut_trilinear(lut: texture_3d<f32>, acescg: vec3f) -> vec3f {
  let n = textureDimensions(lut).x;
  let nf = f32(n);
  let v = clamp((sl_acescg_to_acescct(acescg) - SL_SHAPER_MIN) / (SL_SHAPER_MAX - SL_SHAPER_MIN), vec3f(0.0), vec3f(1.0));
  let u = v * (nf - 1.0);
  let i0 = min(vec3u(floor(u)), vec3u(n - 2u));
  let f = u - vec3f(i0);
  let c000 = textureLoad(lut, i0, 0).rgb;
  let c100 = textureLoad(lut, i0 + vec3u(1u, 0u, 0u), 0).rgb;
  let c010 = textureLoad(lut, i0 + vec3u(0u, 1u, 0u), 0).rgb;
  let c110 = textureLoad(lut, i0 + vec3u(1u, 1u, 0u), 0).rgb;
  let c001 = textureLoad(lut, i0 + vec3u(0u, 0u, 1u), 0).rgb;
  let c101 = textureLoad(lut, i0 + vec3u(1u, 0u, 1u), 0).rgb;
  let c011 = textureLoad(lut, i0 + vec3u(0u, 1u, 1u), 0).rgb;
  let c111 = textureLoad(lut, i0 + vec3u(1u, 1u, 1u), 0).rgb;
  let c00 = mix(c000, c100, f.x);
  let c10 = mix(c010, c110, f.x);
  let c01 = mix(c001, c101, f.x);
  let c11 = mix(c011, c111, f.x);
  return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

fn sl_pow_mirror(c: vec3f, g: f32) -> vec3f {
  return sign(c) * exp2(g * log2(max(abs(c), vec3f(1e-30))));
}
// sRGB EOTF (signal -> linear), sign-preserving extended range.
fn sl_srgb_eotf(c: vec3f) -> vec3f {
  let a = abs(c);
  let y = select(a * ${wf(SRGB.slope)}, exp2(2.4 * log2((a + 0.055) / 1.055)), a >= vec3f(${wf(SRGB.eBreak)}));
  return sign(c) * y;
}
// sRGB inverse EOTF (linear -> signal), sign-preserving extended range.
fn sl_srgb_oetf(c: vec3f) -> vec3f {
  let a = abs(c);
  let y = select(a / ${wf(SRGB.slope)}, 1.055 * exp2(log2(max(a, vec3f(1e-30))) / 2.4) - 0.055, a >= vec3f(${wf(SRGB.lBreak)}));
  return sign(c) * y;
}
fn sl_bt1886_eotf(c: vec3f) -> vec3f { return sl_pow_mirror(c, 2.4); }
fn sl_bt1886_oetf(c: vec3f) -> vec3f { return sl_pow_mirror(c, 1.0 / 2.4); }

// PQ signal -> absolute nits.
fn sl_pq_eotf(c: vec3f) -> vec3f {
  let ep = exp2(log2(max(abs(c), vec3f(1e-30))) / ${wf(PQ_M2)});
  let y = max(ep - ${wf(PQ_C1)}, vec3f(0.0)) / (${wf(PQ_C2)} - ${wf(PQ_C3)} * ep);
  return sign(c) * 10000.0 * exp2(log2(max(y, vec3f(1e-30))) / ${wf(PQ_M1)});
}
// Absolute nits -> PQ signal.
fn sl_pq_oetf(nits: vec3f) -> vec3f {
  let yp = exp2(${wf(PQ_M1)} * log2(max(abs(nits) / 10000.0, vec3f(1e-30))));
  return sign(nits) * exp2(${wf(PQ_M2)} * log2((${wf(PQ_C1)} + ${wf(PQ_C2)} * yp) / (1.0 + ${wf(PQ_C3)} * yp)));
}
// HLG OETF (scene light E in [0,1] -> signal) and inverse.
fn sl_hlg_oetf(c: vec3f) -> vec3f {
  let a = abs(c);
  return sign(c) * select(${wf(HLG_A)} * log(max(12.0 * a - ${wf(HLG_B)}, vec3f(1e-30))) + ${wf(HLG_C)}, sqrt(3.0 * a), a <= vec3f(${wf(1 / 12)}));
}
fn sl_hlg_inv_oetf(c: vec3f) -> vec3f {
  let a = abs(c);
  return sign(c) * select((exp((a - ${wf(HLG_C)}) / ${wf(HLG_A)}) + ${wf(HLG_B)}) / 12.0, a * a / 3.0, a <= vec3f(0.5));
}
fn sl_luma_ap1(c: vec3f) -> f32 { return dot(c, ${v3(LUMA_AP1)}); }
fn sl_luma709(c: vec3f) -> f32 { return dot(c, ${v3(LUMA_709)}); }
fn sl_luma2020(c: vec3f) -> f32 { return dot(c, ${v3(LUMA_2020)}); }
// BT.2100 HLG reference display (Lw = 1000 nits, gamma 1.2): signal -> nits, and nits -> signal.
fn sl_hlg_to_nits(c: vec3f) -> vec3f {
  let e = sl_hlg_inv_oetf(c);
  return e * (${wf(HLG_PEAK_NITS)} * pow(max(sl_luma2020(e), 1e-12), ${wf(HLG_SYSTEM_GAMMA - 1)}));
}
fn sl_nits_to_hlg(nits: vec3f) -> vec3f {
  let yd = max(sl_luma2020(nits) / ${wf(HLG_PEAK_NITS)}, 1e-12);
  return sl_hlg_oetf(nits / ${wf(HLG_PEAK_NITS)} * pow(yd, ${wf((1 - HLG_SYSTEM_GAMMA) / HLG_SYSTEM_GAMMA)}));
}
// "Un-tone-mapped" analytic view: ACEScg -> linear Rec.709 -> clamp [0,1] -> sRGB inverse EOTF.
fn sl_view_srgb_clamp(acescg: vec3f) -> vec3f {
  return sl_srgb_oetf(clamp(AP1_TO_REC709 * acescg, vec3f(0.0), vec3f(1.0)));
}
`;
