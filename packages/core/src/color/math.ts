// SPDX-License-Identifier: Apache-2.0
export type Vec3 = [number, number, number];
/** Row-major 3x3 matrix (9 numbers), out = M * in. */
export type Mat3 = readonly number[];

export function mul3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function matMul(a: Mat3, b: Mat3): number[] {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

/** Format a number as a WGSL float literal (always has a '.' or exponent so it is never an int). */
export function wf(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`non-finite WGSL literal: ${x}`);
  if (Object.is(x, -0)) x = 0;
  const s = String(x);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/** WGSL `mat3x3f(...)` constructor for a row-major matrix (WGSL constructors are column-major). */
export function wgslMat3(m: Mat3): string {
  const cols = [0, 1, 2].map((c) => `${wf(m[c])}, ${wf(m[3 + c])}, ${wf(m[6 + c])}`);
  return `mat3x3f(${cols.join(', ')})`;
}

export const sgn = (x: number) => (x < 0 ? -1 : x > 0 ? 1 : 0);
