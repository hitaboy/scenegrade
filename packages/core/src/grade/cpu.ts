// SPDX-License-Identifier: Apache-2.0
// CPU reference of the grade interpreter (mirrors GRADE_WGSL line by line). Used by the pixel
// probe, by tests and by exporters that need the exact graded value.

import { applyCDL } from '../color/grade.js';
import { acescctToACEScg, acescgToACEScct, LUMA_AP1 } from '../color/transfer.js';
import { CURVE_N } from './curves.js';
import { CCT_MAX, CCT_MIN, F, F_HSL, F_LOG, NODE_VEC4, type PackedGrade } from './pack.js';
import type { V3 } from './model.js';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const fract = (x: number) => x - Math.floor(x);

function curveAt(p: PackedGrade, row: number, x: number): number {
  const u = clamp(x, 0, 1) * (CURVE_N - 1);
  const i = Math.min(Math.floor(u), CURVE_N - 2);
  const f = u - i;
  const o = row * CURVE_N;
  return p.curves[o + i] * (1 - f) + p.curves[o + i + 1] * f;
}
function curveTone(p: PackedGrade, row: number, x: number): number {
  const xc = clamp(x, 0, 1);
  return curveAt(p, row, xc) + (x - xc);
}
function curveWrap(p: PackedGrade, row: number, h: number): number {
  const u = fract(h) * CURVE_N;
  const i = Math.min(Math.floor(u), CURVE_N - 1);
  const j = (i + 1) % CURVE_N;
  const f = u - i;
  const o = row * CURVE_N;
  return p.curves[o + i] * (1 - f) + p.curves[o + j] * f;
}

/** HSV hue of an RGB triple in [0, 1) (0 = red). */
export function hueOf(c: V3): number {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  const d = mx - mn;
  if (d <= 1e-7) return 0;
  let h: number;
  if (mx === c[0]) h = (c[1] - c[2]) / d;
  else if (mx === c[1]) h = (c[2] - c[0]) / d + 2;
  else h = (c[0] - c[1]) / d + 4;
  return fract(h / 6);
}

/** Rotation around the grey axis (1,1,1)/√3 by `a` radians (Rodrigues). */
export function rotateGrey(c: V3, a: number): V3 {
  if (a === 0) return c;
  const k = 1 / Math.sqrt(3);
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  const kd = k * (c[0] + c[1] + c[2]);
  // k × c
  const cx: V3 = [k * (c[2] - c[1]), k * (c[0] - c[2]), k * (c[1] - c[0])];
  return [0, 1, 2].map((i) => c[i] * cs + cx[i] * sn + k * kd * (1 - cs)) as V3;
}

/** Applies a packed grade to an ACEScg value. */
export function applyGradeCPU(p: PackedGrade, acescg: V3): V3 {
  let c: V3 = [acescg[0], acescg[1], acescg[2]];
  const P = p.params;
  for (let k = 0; k < p.nodeCount; k++) {
    const o = 4 + k * NODE_VEC4 * 4;
    const v = (slot: number): [number, number, number, number] => [
      P[o + slot * 4],
      P[o + slot * 4 + 1],
      P[o + slot * 4 + 2],
      P[o + slot * 4 + 3],
    ];
    const [flagsF, mix, rowF, soft] = v(0);
    const flags = flagsF | 0;
    const row = rowF | 0;
    const cin = c;
    if (flags & F.LINEAR) {
      const r0 = v(1);
      const r1 = v(2);
      const r2 = v(3);
      c = [
        r0[0] * c[0] + r0[1] * c[1] + r0[2] * c[2],
        r1[0] * c[0] + r1[1] * c[1] + r1[2] * c[2],
        r2[0] * c[0] + r2[1] * c[1] + r2[2] * c[2],
      ];
    }
    if ((flags & F_LOG) === 0 && mix >= 1) continue;
    let x = acescgToACEScct(c);
    if (flags & F.PRIMARIES) {
      const lift = v(4);
      const gam = v(5);
      const gain = v(6);
      const off = v(7);
      const contrast = lift[3];
      const pivot = gam[3];
      x = [0, 1, 2].map((i) => {
        let y = x[i] + off[i];
        y = (y - pivot) * contrast + pivot;
        y = y * gain[i] + lift[i] * (1 - y);
        return y > 0 ? y ** gam[i] : y;
      }) as V3;
    }
    if (flags & F.LOG_WHEELS) {
      const sh = v(8);
      const md = v(9);
      const hi = v(10);
      const yw = dot(x, LUMA_AP1);
      const ws = 1 - smoothstep(sh[3] - soft, sh[3] + soft, yw);
      const wh = smoothstep(md[3] - soft, md[3] + soft, yw);
      const wm = clamp(1 - ws - wh, 0, 1);
      x = [0, 1, 2].map((i) => x[i] + ws * sh[i] + wm * md[i] + wh * hi[i]) as V3;
    }
    if (flags & F.CDL) {
      const s = v(11);
      const of = v(12);
      const pw = v(13);
      x = applyCDL(x, {
        slope: [s[0], s[1], s[2]],
        offset: [of[0], of[1], of[2]],
        power: [pw[0], pw[1], pw[2]],
        sat: s[3],
      });
    }
    if (flags & F.CURVE_R) x[0] = curveTone(p, row, x[0]);
    if (flags & F.CURVE_G) x[1] = curveTone(p, row + 1, x[1]);
    if (flags & F.CURVE_B) x[2] = curveTone(p, row + 2, x[2]);
    if (flags & F.CURVE_Y) x = x.map((e) => curveTone(p, row + 3, e)) as V3;
    if (flags & F_HSL) {
      const y0 = dot(x, LUMA_AP1);
      const mx = Math.max(x[0], x[1], x[2]);
      const mn = Math.min(x[0], x[1], x[2]);
      const chroma = mx - mn;
      const h = hueOf(x);
      let rot = flags & F.SAT_HUE ? v(7)[3] : 0;
      let g = flags & F.SAT_HUE ? v(6)[3] : 1;
      let lum = 0;
      if (flags & F.HUE_HUE) rot += 2 * Math.PI * curveWrap(p, row + 4, h);
      if (flags & F.HUE_SAT) g *= 1 + curveWrap(p, row + 5, h);
      if (flags & F.HUE_LUM) lum = curveWrap(p, row + 6, h) * clamp(chroma * 10, 0, 1);
      if (flags & F.LUM_SAT) g *= 1 + curveAt(p, row + 7, y0);
      if (flags & F.SAT_SAT) g *= 1 + curveAt(p, row + 8, chroma);
      x = rotateGrey(x, rot);
      const y1 = dot(x, LUMA_AP1);
      x = x.map((e) => y1 + (e - y1) * Math.max(g, 0) + lum) as V3;
    }
    if (mix < 1) {
      const xi = acescgToACEScct(cin);
      x = [0, 1, 2].map((i) => xi[i] + (x[i] - xi[i]) * mix) as V3;
    }
    // Keep values inside f32 range whatever the grade does (−1 … 2 ACEScct ≈ −0.1 … 4e7 linear).
    x = x.map((e) => clamp(e, CCT_MIN, CCT_MAX)) as V3;
    c = acescctToACEScg(x);
  }
  return c;
}
