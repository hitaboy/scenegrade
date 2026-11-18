// SPDX-License-Identifier: Apache-2.0
// Look / grading helpers: ASC CDL and .cube LUT parsing.

import type { Vec3 } from './math.js';

// ---------------------------------------------------------------------------
// ASC CDL
// ---------------------------------------------------------------------------
// Convention: the CDL is applied to ACEScct-encoded values (as in ACES/OCIO pipelines,
// "ACEScct" being the working space for on-set CDLs, cf. ACES S-2016-001 / Look Transforms).
// Typical pipeline:   acescg -> acescct -> CDL -> acescct -> acescg -> view transform.
// Maths = ASC CDL v1.2 "no-clamp" variant (OCIO CDL_NO_CLAMP):
//   v = in * slope + offset;  v = v > 0 ? v^power : v;  out = luma + sat * (v - luma)
// with the ASC's fixed Rec.709 luma weights (0.2126, 0.7152, 0.0722), regardless of working space.
const CDL_LUMA: Vec3 = [0.2126, 0.7152, 0.0722];

export interface CDL {
  slope: Vec3;
  offset: Vec3;
  power: Vec3;
  sat: number;
}

export const CDL_IDENTITY: CDL = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 };

/** Apply an ASC CDL (no-clamp) to an ACEScct-encoded value. */
export function applyCDL(c: Vec3, cdl: CDL): Vec3 {
  const v = [0, 1, 2].map((i) => {
    const x = c[i] * cdl.slope[i] + cdl.offset[i];
    return x > 0 ? x ** cdl.power[i] : x;
  });
  const l = v[0] * CDL_LUMA[0] + v[1] * CDL_LUMA[1] + v[2] * CDL_LUMA[2];
  return [l + cdl.sat * (v[0] - l), l + cdl.sat * (v[1] - l), l + cdl.sat * (v[2] - l)];
}

/** WGSL for `fn sl_cdl(c, slope, offset, power, sat) -> vec3f`, applied to ACEScct values. */
export const CDL_WGSL = /* wgsl */ `
// ASC CDL v1.2, no-clamp variant (OCIO CDL_NO_CLAMP). Apply to ACEScct-encoded values.
fn sl_cdl(c: vec3f, slope: vec3f, offset: vec3f, power: vec3f, sat: f32) -> vec3f {
  let v = c * slope + offset;
  let p = select(v, exp2(power * log2(max(v, vec3f(1e-30)))), v > vec3f(0.0));
  let l = dot(p, vec3f(0.2126, 0.7152, 0.0722));
  return vec3f(l) + sat * (p - vec3f(l));
}
`;

// ---------------------------------------------------------------------------
// .cube parser (Adobe/IRIDAS spec 1.0 + Resolve variants)
// ---------------------------------------------------------------------------
export interface CubeLut {
  size: number;
  /** RGBA float32 (alpha = 1). 3D: r fastest (index = r + g*N + b*N*N). 1D: N entries. */
  data: Float32Array;
  domainMin: Vec3;
  domainMax: Vec3;
  title?: string;
  is1D: boolean;
  /** Resolve-style combined file: 1D shaper applied before the 3D table. */
  shaper?: { size: number; data: Float32Array; domainMin: Vec3; domainMax: Vec3 };
}

/**
 * Parse a .cube file. Handles: TITLE, LUT_1D_SIZE, LUT_3D_SIZE, DOMAIN_MIN/DOMAIN_MAX,
 * LUT_1D_INPUT_RANGE / LUT_3D_INPUT_RANGE (Resolve), `#` comments (full-line and trailing),
 * CRLF, blank lines, keyword case, and Resolve combined 1D+3D files (the 1D table is listed
 * first and becomes `shaper`).
 */
export function parseCubeLut(text: string): CubeLut {
  let title: string | undefined;
  let size1 = 0;
  let size3 = 0;
  let dmin: Vec3 | undefined;
  let dmax: Vec3 | undefined;
  let r1: [number, number] | undefined;
  let r3: [number, number] | undefined;
  const values: number[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    let line = lines[ln];
    const hash = line.indexOf('#');
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;
    const c0 = line.charCodeAt(0);
    const isNum = (c0 >= 48 && c0 <= 57) || c0 === 45 || c0 === 43 || c0 === 46; // digit - + .
    if (isNum) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) throw new Error(`.cube line ${ln + 1}: expected 3 values`);
      for (let k = 0; k < 3; k++) {
        const v = Number(parts[k]);
        if (!Number.isFinite(v))
          throw new Error(`.cube line ${ln + 1}: invalid number "${parts[k]}"`);
        values.push(v);
      }
      continue;
    }
    const m = /^(\S+)\s*(.*)$/.exec(line)!;
    const key = m[1].toUpperCase();
    const rest = m[2].trim();
    const nums = () => rest.split(/\s+/).map(Number);
    switch (key) {
      case 'TITLE':
        title = rest.replace(/^"(.*)"$/, '$1');
        break;
      case 'LUT_1D_SIZE':
        size1 = parseInt(rest, 10);
        break;
      case 'LUT_3D_SIZE':
        size3 = parseInt(rest, 10);
        break;
      case 'DOMAIN_MIN':
        dmin = nums().slice(0, 3) as Vec3;
        break;
      case 'DOMAIN_MAX':
        dmax = nums().slice(0, 3) as Vec3;
        break;
      case 'LUT_1D_INPUT_RANGE':
        r1 = nums().slice(0, 2) as [number, number];
        break;
      case 'LUT_3D_INPUT_RANGE':
        r3 = nums().slice(0, 2) as [number, number];
        break;
      default:
        // Unknown keywords (e.g. LUT_IN_VIDEO_RANGE, LUT_OUT_VIDEO_RANGE) are ignored.
        break;
    }
  }
  if (!size1 && !size3) throw new Error('.cube: missing LUT_1D_SIZE / LUT_3D_SIZE');
  const n1 = size1 * 3;
  const n3 = size3 * size3 * size3 * 3;
  if (values.length !== n1 + n3) {
    throw new Error(`.cube: expected ${(n1 + n3) / 3} entries, found ${values.length / 3}`);
  }
  const rgba = (from: number, count: number) => {
    const d = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      d[i * 4] = values[from + i * 3];
      d[i * 4 + 1] = values[from + i * 3 + 1];
      d[i * 4 + 2] = values[from + i * 3 + 2];
      d[i * 4 + 3] = 1;
    }
    return d;
  };
  if (size3) {
    // DOMAIN_MIN/MAX belong to the 3D table unless the file also carries a 1D shaper
    // (Resolve combined files then use LUT_1D/3D_INPUT_RANGE).
    const dmin3: Vec3 = r3 ? [r3[0], r3[0], r3[0]] : !size1 && dmin ? dmin : [0, 0, 0];
    const dmax3: Vec3 = r3 ? [r3[1], r3[1], r3[1]] : !size1 && dmax ? dmax : [1, 1, 1];
    const out: CubeLut = {
      size: size3,
      data: rgba(n1, size3 * size3 * size3),
      domainMin: dmin3,
      domainMax: dmax3,
      title,
      is1D: false,
    };
    if (size1) {
      out.shaper = {
        size: size1,
        data: rgba(0, size1),
        domainMin: r1 ? [r1[0], r1[0], r1[0]] : (dmin ?? [0, 0, 0]),
        domainMax: r1 ? [r1[1], r1[1], r1[1]] : (dmax ?? [1, 1, 1]),
      };
    }
    return out;
  }
  return {
    size: size1,
    data: rgba(0, size1),
    domainMin: r1 ? [r1[0], r1[0], r1[0]] : (dmin ?? [0, 0, 0]),
    domainMax: r1 ? [r1[1], r1[1], r1[1]] : (dmax ?? [1, 1, 1]),
    title,
    is1D: true,
  };
}

/** CPU evaluation of a parsed .cube (linear 1D interpolation / trilinear 3D), for tests & probes. */
export function applyCubeCPU(lut: CubeLut, rgb: Vec3): Vec3 {
  let c: Vec3 = [rgb[0], rgb[1], rgb[2]];
  const lerp1 = (
    t: { size: number; data: Float32Array; domainMin: Vec3; domainMax: Vec3 },
    x: Vec3,
  ): Vec3 =>
    [0, 1, 2].map((k) => {
      const n = t.size;
      const u =
        Math.min(Math.max((x[k] - t.domainMin[k]) / (t.domainMax[k] - t.domainMin[k]), 0), 1) *
        (n - 1);
      const i = Math.min(Math.floor(u), n - 2);
      const f = u - i;
      return t.data[i * 4 + k] * (1 - f) + t.data[(i + 1) * 4 + k] * f;
    }) as Vec3;
  if (lut.shaper) c = lerp1(lut.shaper, c);
  if (lut.is1D) return lerp1(lut, c);
  const n = lut.size;
  const i0 = [0, 0, 0];
  const fr = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const u =
      Math.min(Math.max((c[k] - lut.domainMin[k]) / (lut.domainMax[k] - lut.domainMin[k]), 0), 1) *
      (n - 1);
    i0[k] = Math.min(Math.floor(u), n - 2);
    fr[k] = u - i0[k];
  }
  const out: Vec3 = [0, 0, 0];
  for (let db = 0; db < 2; db++)
    for (let dg = 0; dg < 2; dg++)
      for (let dr = 0; dr < 2; dr++) {
        const w = (dr ? fr[0] : 1 - fr[0]) * (dg ? fr[1] : 1 - fr[1]) * (db ? fr[2] : 1 - fr[2]);
        const idx = 4 * (i0[0] + dr + (i0[1] + dg) * n + (i0[2] + db) * n * n);
        out[0] += w * lut.data[idx];
        out[1] += w * lut.data[idx + 1];
        out[2] += w * lut.data[idx + 2];
      }
  return out;
}
