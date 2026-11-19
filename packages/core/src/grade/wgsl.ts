// SPDX-License-Identifier: Apache-2.0
// WGSL grade interpreter. Mirrors applyGradeCPU (cpu.ts) exactly; keep them in sync.
// Requires COMMON_WGSL (sl_acescg_to_acescct / sl_acescct_to_acescg) and CDL_WGSL (sl_cdl).

import { CURVE_N } from './curves.js';
import { CCT_MAX, CCT_MIN, F, F_HSL, F_LOG, NODE_VEC4 } from './pack.js';

/** Bindings used by the grade: storage params and the r32float curve table. */
export const GRADE_BINDINGS_WGSL = /* wgsl */ `
@group(0) @binding(7) var<storage, read> gradeP : array<vec4f>;
@group(0) @binding(8) var gradeCurves : texture_2d<f32>;
`;

export const GRADE_WGSL = /* wgsl */ `
const SL_CURVE_N : u32 = ${CURVE_N}u;
const SL_LUMA_AP1 = vec3f(0.2722287168, 0.6740817658, 0.0536895174);

fn sl_curve_at(row: u32, x: f32) -> f32 {
  let u = clamp(x, 0.0, 1.0) * f32(SL_CURVE_N - 1u);
  let i = min(u32(floor(u)), SL_CURVE_N - 2u);
  let f = u - f32(i);
  let a = textureLoad(gradeCurves, vec2u(i, row), 0).r;
  let b = textureLoad(gradeCurves, vec2u(i + 1u, row), 0).r;
  return a * (1.0 - f) + b * f;
}
fn sl_curve_tone(row: u32, x: f32) -> f32 {
  let xc = clamp(x, 0.0, 1.0);
  return sl_curve_at(row, xc) + (x - xc);
}
fn sl_curve_wrap(row: u32, h: f32) -> f32 {
  let u = fract(h) * f32(SL_CURVE_N);
  let i = min(u32(floor(u)), SL_CURVE_N - 1u);
  let j = (i + 1u) % SL_CURVE_N;
  let f = u - f32(i);
  let a = textureLoad(gradeCurves, vec2u(i, row), 0).r;
  let b = textureLoad(gradeCurves, vec2u(j, row), 0).r;
  return a * (1.0 - f) + b * f;
}
fn sl_hue(c: vec3f) -> f32 {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let d = mx - mn;
  if (d <= 1e-7) { return 0.0; }
  var h: f32;
  if (mx == c.r) { h = (c.g - c.b) / d; }
  else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  return fract(h / 6.0);
}
fn sl_rotate_grey(c: vec3f, a: f32) -> vec3f {
  if (a == 0.0) { return c; }
  let k = 0.5773502691896258;
  let cs = cos(a);
  let sn = sin(a);
  let kd = k * (c.r + c.g + c.b);
  let cx = vec3f(k * (c.b - c.g), k * (c.r - c.b), k * (c.g - c.r));
  return c * cs + cx * sn + vec3f(k * kd * (1.0 - cs));
}

/** Applies the packed grade (gradeP / gradeCurves) to linear ACEScg. */
fn sl_grade(c0: vec3f) -> vec3f {
  let count = u32(gradeP[0].x);
  var c = c0;
  for (var k = 0u; k < count; k++) {
    let o = 1u + k * ${NODE_VEC4}u;
    let h0 = gradeP[o];
    let flags = u32(h0.x);
    let mixv = h0.y;
    let row = u32(h0.z);
    let soft = h0.w;
    let cin = c;
    if ((flags & ${F.LINEAR}u) != 0u) {
      c = vec3f(dot(gradeP[o + 1u].xyz, c), dot(gradeP[o + 2u].xyz, c), dot(gradeP[o + 3u].xyz, c));
    }
    if ((flags & ${F_LOG}u) == 0u && mixv >= 1.0) { continue; }
    var x = sl_acescg_to_acescct(c);
    if ((flags & ${F.PRIMARIES}u) != 0u) {
      let lift = gradeP[o + 4u];
      let gam = gradeP[o + 5u];
      let gain = gradeP[o + 6u];
      let off = gradeP[o + 7u];
      var y = x + off.xyz;
      y = (y - vec3f(gam.w)) * lift.w + vec3f(gam.w);
      y = y * gain.xyz + lift.xyz * (vec3f(1.0) - y);
      x = select(y, pow(max(y, vec3f(1e-30)), gam.xyz), y > vec3f(0.0));
    }
    if ((flags & ${F.LOG_WHEELS}u) != 0u) {
      let sh = gradeP[o + 8u];
      let md = gradeP[o + 9u];
      let hi = gradeP[o + 10u];
      let yw = dot(x, SL_LUMA_AP1);
      let ws = 1.0 - smoothstep(sh.w - soft, sh.w + soft, yw);
      let wh = smoothstep(md.w - soft, md.w + soft, yw);
      let wm = clamp(1.0 - ws - wh, 0.0, 1.0);
      x = x + ws * sh.xyz + wm * md.xyz + wh * hi.xyz;
    }
    if ((flags & ${F.CDL}u) != 0u) {
      let s = gradeP[o + 11u];
      x = sl_cdl(x, s.xyz, gradeP[o + 12u].xyz, gradeP[o + 13u].xyz, s.w);
    }
    if ((flags & ${F.CURVE_R}u) != 0u) { x.r = sl_curve_tone(row, x.r); }
    if ((flags & ${F.CURVE_G}u) != 0u) { x.g = sl_curve_tone(row + 1u, x.g); }
    if ((flags & ${F.CURVE_B}u) != 0u) { x.b = sl_curve_tone(row + 2u, x.b); }
    if ((flags & ${F.CURVE_Y}u) != 0u) {
      x = vec3f(sl_curve_tone(row + 3u, x.r), sl_curve_tone(row + 3u, x.g), sl_curve_tone(row + 3u, x.b));
    }
    if ((flags & ${F_HSL}u) != 0u) {
      let y0 = dot(x, SL_LUMA_AP1);
      let chroma = max(x.r, max(x.g, x.b)) - min(x.r, min(x.g, x.b));
      let h = sl_hue(x);
      var rot = 0.0;
      var g = 1.0;
      var lum = 0.0;
      if ((flags & ${F.SAT_HUE}u) != 0u) { rot = gradeP[o + 7u].w; g = gradeP[o + 6u].w; }
      if ((flags & ${F.HUE_HUE}u) != 0u) { rot += 6.283185307179586 * sl_curve_wrap(row + 4u, h); }
      if ((flags & ${F.HUE_SAT}u) != 0u) { g *= 1.0 + sl_curve_wrap(row + 5u, h); }
      if ((flags & ${F.HUE_LUM}u) != 0u) { lum = sl_curve_wrap(row + 6u, h) * clamp(chroma * 10.0, 0.0, 1.0); }
      if ((flags & ${F.LUM_SAT}u) != 0u) { g *= 1.0 + sl_curve_at(row + 7u, y0); }
      if ((flags & ${F.SAT_SAT}u) != 0u) { g *= 1.0 + sl_curve_at(row + 8u, chroma); }
      x = sl_rotate_grey(x, rot);
      let y1 = dot(x, SL_LUMA_AP1);
      x = vec3f(y1) + (x - vec3f(y1)) * max(g, 0.0) + vec3f(lum);
    }
    if (mixv < 1.0) {
      let xi = sl_acescg_to_acescct(cin);
      x = xi + (x - xi) * mixv;
    }
    c = sl_acescct_to_acescg(clamp(x, vec3f(${CCT_MIN.toFixed(1)}), vec3f(${CCT_MAX.toFixed(1)})));
  }
  return c;
}
`;
