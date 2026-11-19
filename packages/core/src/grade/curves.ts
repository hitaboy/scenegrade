// SPDX-License-Identifier: Apache-2.0
// Curve interpolation (monotone cubic, Fritsch–Carlson) and baking to fixed-size tables that the
// GPU and the CPU reference sample identically.

import type { CurvePoints } from './model.js';

/** Samples per baked curve. */
export const CURVE_N = 1024;

/**
 * Monotone cubic Hermite interpolation through sorted points (no overshoot between points).
 * Outside the point range the curve continues with the offset of the nearest end point when
 * `extend` is 'offset' (y − x constant, for tone curves) or with the end value when 'flat'.
 */
export function makeSpline(points: CurvePoints, extend: 'offset' | 'flat'): (x: number) => number {
  const pts = dedupe(points);
  const n = pts.length;
  if (n === 0) return extend === 'offset' ? (x) => x : () => 0;
  if (n === 1) {
    const [x0, y0] = pts[0];
    return extend === 'offset' ? (x) => x + (y0 - x0) : () => y0;
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const m = tangents(xs, ys);
  return (x) => {
    if (x <= xs[0]) return extend === 'offset' ? ys[0] + (x - xs[0]) : ys[0];
    if (x >= xs[n - 1]) return extend === 'offset' ? ys[n - 1] + (x - xs[n - 1]) : ys[n - 1];
    let k = 0;
    while (k < n - 2 && x > xs[k + 1]) k++;
    return hermite(xs[k], xs[k + 1], ys[k], ys[k + 1], m[k], m[k + 1], x);
  };
}

/** Periodic monotone cubic over [0, 1) (for hue curves). */
export function makePeriodicSpline(points: CurvePoints): (x: number) => number {
  const pts = dedupe(points.map(([x, y]) => [((x % 1) + 1) % 1, y] as [number, number]));
  const n = pts.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => pts[0][1];
  // Wrap two points on each side so the tangents at the seams see their neighbours.
  const ext: CurvePoints = [
    [pts[n - 2][0] - 1, pts[n - 2][1]],
    [pts[n - 1][0] - 1, pts[n - 1][1]],
    ...pts,
    [pts[0][0] + 1, pts[0][1]],
    [pts[1][0] + 1, pts[1][1]],
  ];
  const xs = ext.map((p) => p[0]);
  const ys = ext.map((p) => p[1]);
  const m = tangents(xs, ys);
  return (x0) => {
    const x = ((x0 % 1) + 1) % 1;
    let k = 0;
    while (k < xs.length - 2 && x > xs[k + 1]) k++;
    return hermite(xs[k], xs[k + 1], ys[k], ys[k + 1], m[k], m[k + 1], x);
  };
}

function dedupe(points: CurvePoints): CurvePoints {
  const s = [...points].sort((a, b) => a[0] - b[0]);
  const out: CurvePoints = [];
  for (const p of s) {
    if (out.length && Math.abs(out[out.length - 1][0] - p[0]) < 1e-9) out[out.length - 1] = p;
    else out.push([p[0], p[1]]);
  }
  return out;
}

function tangents(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const d: number[] = [];
  for (let k = 0; k < n - 1; k++) d.push((ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]));
  const m = new Array<number>(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) {
      m[k] = 0;
      m[k + 1] = 0;
      continue;
    }
    const a = m[k] / d[k];
    const b = m[k + 1] / d[k];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[k] = t * a * d[k];
      m[k + 1] = t * b * d[k];
    }
  }
  return m;
}

function hermite(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  m0: number,
  m1: number,
  x: number,
): number {
  const h = x1 - x0;
  const t = (x - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * y0 +
    (t3 - 2 * t2 + t) * h * m0 +
    (-2 * t3 + 3 * t2) * y1 +
    (t3 - t2) * h * m1
  );
}

/**
 * Bakes a curve into `out` (CURVE_N samples).
 * - 'tone'    : samples at x = i / (N − 1), stores y (for R/G/B/Y curves, domain [0, 1]).
 * - 'delta'   : same sampling, stores y with flat extension (lum vs sat, sat vs sat).
 * - 'periodic': samples at x = i / N, stores y (hue curves).
 */
export function bakeCurve(
  points: CurvePoints,
  kind: 'tone' | 'delta' | 'periodic',
  out: Float32Array,
  offset = 0,
): void {
  const f =
    kind === 'periodic'
      ? makePeriodicSpline(points)
      : makeSpline(points, kind === 'tone' ? 'offset' : 'flat');
  const denom = kind === 'periodic' ? CURVE_N : CURVE_N - 1;
  for (let i = 0; i < CURVE_N; i++) out[offset + i] = f(i / denom);
}
