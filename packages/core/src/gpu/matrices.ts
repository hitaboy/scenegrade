/** Small 3x3 colour matrix toolkit used by the renderer (primaries conversion, chromatic adaptation). */

export type M3 = [number, number, number, number, number, number, number, number, number];
type XY = [number, number];

export interface Primaries {
  r: XY;
  g: XY;
  b: XY;
  w: XY;
}

export const PRIMARIES = {
  ap1: { r: [0.713, 0.293], g: [0.165, 0.83], b: [0.128, 0.044], w: [0.32168, 0.33767] },
  ap0: { r: [0.7347, 0.2653], g: [0.0, 1.0], b: [0.0001, -0.077], w: [0.32168, 0.33767] },
  rec709: { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], w: [0.3127, 0.329] },
  p3d65: { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], w: [0.3127, 0.329] },
  rec2020: { r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046], w: [0.3127, 0.329] },
} satisfies Record<string, Primaries>;

export function mul(a: M3, b: M3): M3 {
  const r = new Array(9).fill(0) as M3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export function apply(m: M3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function inv(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

const xyz = ([x, y]: XY): [number, number, number] => [x / y, 1, (1 - x - y) / y];

export function rgbToXyz(p: Primaries): M3 {
  const [r, g, b] = [xyz(p.r), xyz(p.g), xyz(p.b)];
  const m: M3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const s = apply(inv(m), xyz(p.w));
  return [
    m[0] * s[0],
    m[1] * s[1],
    m[2] * s[2],
    m[3] * s[0],
    m[4] * s[1],
    m[5] * s[2],
    m[6] * s[0],
    m[7] * s[1],
    m[8] * s[2],
  ];
}

/** Bradford cone response matrix (what the ACES 2.x OCIO studio config uses for D60 <-> D65). */
export const BRADFORD: M3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
/** CAT02 cone response matrix. */
export const CAT02: M3 = [0.7328, 0.4296, -0.1624, -0.7036, 1.6975, 0.0061, 0.003, 0.0136, 0.9834];

export function adapt(fromW: XY, toW: XY, cone: M3 = BRADFORD): M3 {
  const s = apply(cone, xyz(fromW));
  const d = apply(cone, xyz(toW));
  const diag: M3 = [d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]];
  return mul(inv(cone), mul(diag, cone));
}

/** Linear RGB in `from` primaries -> linear RGB in `to` primaries (with white point adaptation). */
export function rgbToRgb(from: Primaries, to: Primaries): M3 {
  let m = rgbToXyz(from);
  if (from.w[0] !== to.w[0] || from.w[1] !== to.w[1]) m = mul(adapt(from.w, to.w), m);
  return mul(inv(rgbToXyz(to)), m);
}
