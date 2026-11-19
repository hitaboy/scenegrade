// SPDX-License-Identifier: Apache-2.0
// Grade data model: a serialisable, versioned description of a colour grade.
//
// A grade is a list of nodes applied in series to scene-linear ACEScg. Each node has a fixed
// internal order (like a Resolve/Baselight node):
//
//   ACEScg ── linear stage (exposure · white balance · channel mixer)
//          ── to ACEScct
//          ── offset → contrast/pivot → lift/gain → gamma
//          ── log wheels (shadows / midtones / highlights)
//          ── ASC CDL
//          ── curves (R, G, B, then Y on all channels)
//          ── HSL curves (hue vs hue/sat/lum, lum vs sat, sat vs sat) + saturation + hue
//          ── mix with the node input
//          ── back to ACEScg
//
// Every field has an identity value; identity parts cost nothing on the GPU.

export type V3 = [number, number, number];
/** Colour wheel value: per-channel r, g, b plus a master component. */
export type V4 = [number, number, number, number];
/** Curve control points (x, y), sorted by x, both normally in [0, 1]. */
export type CurvePoints = [number, number][];

export interface LinearOps {
  /** Exposure in stops (linear gain 2^exposure). */
  exposure: number;
  /** Assumed scene illuminant in kelvin; 6500 is neutral. Lower values cool the image. */
  temperature: number;
  /** Green (−) / magenta (+) shift perpendicular to the Planckian locus, ±1 ≈ ±0.02 Duv. */
  tint: number;
  /** Channel mixer, row-major 3×3 in ACEScg (out = M · in). */
  mixer: number[];
}

export interface PrimaryOps {
  /** Additive in ACEScct, moves blacks while keeping 1.0 fixed. Effective = rgb + master. */
  lift: V4;
  /** Exponent adjust: effective exponent = 2^-(rgb + master). Positive values brighten mids. */
  gamma: V4;
  /** Multiplier in ACEScct around 0. Effective = rgb × master. */
  gain: V4;
  /** Additive in ACEScct (Resolve "offset"). Effective = rgb + master. */
  offset: V4;
  contrast: number;
  /** Contrast pivot in ACEScct (default = 18 % grey). */
  pivot: number;
  saturation: number;
  /** Hue rotation in turns (−0.5 … 0.5). */
  hue: number;
}

export interface LogWheelOps {
  shadows: V3;
  midtones: V3;
  highlights: V3;
  /** ACEScct value below which the shadow wheel acts. */
  lowRange: number;
  /** ACEScct value above which the highlight wheel acts. */
  highRange: number;
}

export interface CdlOps {
  enabled: boolean;
  slope: V3;
  offset: V3;
  power: V3;
  saturation: number;
}

export interface CurveOps {
  r: CurvePoints;
  g: CurvePoints;
  b: CurvePoints;
  /** Luma curve, applied to R, G and B alike after the channel curves. */
  y: CurvePoints;
  /** y = hue shift in turns (−0.5 … 0.5), neutral 0. Periodic in x (hue 0 = red). */
  hueHue: CurvePoints;
  /** y = saturation change (−1 … 1, gain 1 + y), neutral 0. Periodic. */
  hueSat: CurvePoints;
  /** y = luminance offset in ACEScct, neutral 0. Periodic. */
  hueLum: CurvePoints;
  /** x = ACEScct luma; y = saturation change (gain 1 + y). */
  lumSat: CurvePoints;
  /** x = saturation (max − min in ACEScct); y = saturation change (gain 1 + y). */
  satSat: CurvePoints;
}

export interface GradeNode {
  id: string;
  label: string;
  enabled: boolean;
  /** Blend of the node output with its input (0 … 1). */
  mix: number;
  linear: LinearOps;
  primaries: PrimaryOps;
  logWheels: LogWheelOps;
  cdl: CdlOps;
  curves: CurveOps;
}

export interface Grade {
  version: 1;
  /** Global bypass (compare against the ungraded image). */
  enabled: boolean;
  nodes: GradeNode[];
}

export const GRADE_VERSION = 1;
/** ACEScct value of 18 % grey. */
export const PIVOT_18 = 0.4135884;
export const NEUTRAL_KELVIN = 6500;
export const IDENTITY_CURVE: CurvePoints = [
  [0, 0],
  [1, 1],
];
const IDENTITY_M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

let idCounter = 0;
function newId(): string {
  idCounter = (idCounter + 1) % 1e6;
  return `n${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function defaultNode(label = 'Node'): GradeNode {
  return {
    id: newId(),
    label,
    enabled: true,
    mix: 1,
    linear: { exposure: 0, temperature: NEUTRAL_KELVIN, tint: 0, mixer: [...IDENTITY_M3] },
    primaries: {
      lift: [0, 0, 0, 0],
      gamma: [0, 0, 0, 0],
      gain: [1, 1, 1, 1],
      offset: [0, 0, 0, 0],
      contrast: 1,
      pivot: PIVOT_18,
      saturation: 1,
      hue: 0,
    },
    logWheels: {
      shadows: [0, 0, 0],
      midtones: [0, 0, 0],
      highlights: [0, 0, 0],
      lowRange: 0.333,
      highRange: 0.55,
    },
    cdl: {
      enabled: false,
      slope: [1, 1, 1],
      offset: [0, 0, 0],
      power: [1, 1, 1],
      saturation: 1,
    },
    curves: {
      r: copyCurve(IDENTITY_CURVE),
      g: copyCurve(IDENTITY_CURVE),
      b: copyCurve(IDENTITY_CURVE),
      y: copyCurve(IDENTITY_CURVE),
      hueHue: [],
      hueSat: [],
      hueLum: [],
      lumSat: [],
      satSat: [],
    },
  };
}

export function defaultGrade(): Grade {
  return { version: 1, enabled: true, nodes: [defaultNode('Node 1')] };
}

const copyCurve = (c: CurvePoints): CurvePoints => c.map(([x, y]) => [x, y]);

export function cloneGrade(g: Grade): Grade {
  return JSON.parse(JSON.stringify(g)) as Grade;
}

// ---------------------------------------------------------------------------------------------
// Identity tests (decide what the GPU has to evaluate)
// ---------------------------------------------------------------------------------------------

const eq = (a: readonly number[], b: readonly number[]) => a.every((v, i) => v === b[i]);

export function isIdentityRgbCurve(c: CurvePoints): boolean {
  return c.length === 0 || c.every(([x, y]) => x === y);
}
export function isIdentityDeltaCurve(c: CurvePoints): boolean {
  return c.every(([, y]) => y === 0);
}

export const nodeIs = {
  linear: (n: GradeNode) =>
    n.linear.exposure !== 0 ||
    n.linear.temperature !== NEUTRAL_KELVIN ||
    n.linear.tint !== 0 ||
    !eq(n.linear.mixer, IDENTITY_M3),
  primaries: (n: GradeNode) => {
    const p = n.primaries;
    return (
      !eq(p.lift, [0, 0, 0, 0]) ||
      !eq(p.gamma, [0, 0, 0, 0]) ||
      !eq(p.gain, [1, 1, 1, 1]) ||
      !eq(p.offset, [0, 0, 0, 0]) ||
      p.contrast !== 1
    );
  },
  satHue: (n: GradeNode) => n.primaries.saturation !== 1 || n.primaries.hue !== 0,
  logWheels: (n: GradeNode) => {
    const w = n.logWheels;
    return !eq(w.shadows, [0, 0, 0]) || !eq(w.midtones, [0, 0, 0]) || !eq(w.highlights, [0, 0, 0]);
  },
  cdl: (n: GradeNode) => {
    const c = n.cdl;
    return (
      c.enabled &&
      (!eq(c.slope, [1, 1, 1]) ||
        !eq(c.offset, [0, 0, 0]) ||
        !eq(c.power, [1, 1, 1]) ||
        c.saturation !== 1)
    );
  },
};

export function isIdentityNode(n: GradeNode): boolean {
  if (!n.enabled || n.mix === 0) return true;
  const c = n.curves;
  return (
    !nodeIs.linear(n) &&
    !nodeIs.primaries(n) &&
    !nodeIs.satHue(n) &&
    !nodeIs.logWheels(n) &&
    !nodeIs.cdl(n) &&
    [c.r, c.g, c.b, c.y].every(isIdentityRgbCurve) &&
    [c.hueHue, c.hueSat, c.hueLum, c.lumSat, c.satSat].every(isIdentityDeltaCurve)
  );
}

export function isIdentityGrade(g: Grade | null | undefined): boolean {
  return !g || !g.enabled || g.nodes.every(isIdentityNode);
}

// ---------------------------------------------------------------------------------------------
// Normalisation: accept partial / older / foreign JSON and return a complete, valid Grade.
// ---------------------------------------------------------------------------------------------

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec = <T extends number[]>(v: unknown, d: T): T =>
  (Array.isArray(v) && v.length === d.length ? d.map((x, i) => num(v[i], x)) : [...d]) as T;
const curve = (v: unknown, d: CurvePoints): CurvePoints => {
  if (!Array.isArray(v)) return copyCurve(d);
  const pts = v
    .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2)
    .map(([x, y]) => [num(x, 0), num(y, 0)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  return pts;
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export function normalizeNode(input: unknown, index = 0): GradeNode {
  const i = obj(input);
  const d = defaultNode(`Node ${index + 1}`);
  const l = obj(i.linear);
  const p = obj(i.primaries);
  const w = obj(i.logWheels);
  const c = obj(i.cdl);
  const cv = obj(i.curves);
  return {
    id: typeof i.id === 'string' && i.id ? i.id : d.id,
    label: typeof i.label === 'string' ? i.label : d.label,
    enabled: i.enabled !== false,
    mix: Math.min(1, Math.max(0, num(i.mix, 1))),
    linear: {
      exposure: num(l.exposure, 0),
      temperature: Math.min(25000, Math.max(1700, num(l.temperature, NEUTRAL_KELVIN))),
      tint: num(l.tint, 0),
      mixer: vec(l.mixer, [...IDENTITY_M3]),
    },
    primaries: {
      lift: vec(p.lift, d.primaries.lift),
      gamma: vec(p.gamma, d.primaries.gamma),
      gain: vec(p.gain, d.primaries.gain),
      offset: vec(p.offset, d.primaries.offset),
      contrast: num(p.contrast, 1),
      pivot: num(p.pivot, PIVOT_18),
      saturation: Math.max(0, num(p.saturation, 1)),
      hue: num(p.hue, 0),
    },
    logWheels: {
      shadows: vec(w.shadows, d.logWheels.shadows),
      midtones: vec(w.midtones, d.logWheels.midtones),
      highlights: vec(w.highlights, d.logWheels.highlights),
      lowRange: num(w.lowRange, d.logWheels.lowRange),
      highRange: num(w.highRange, d.logWheels.highRange),
    },
    cdl: {
      enabled: c.enabled === true,
      slope: vec(c.slope, d.cdl.slope),
      offset: vec(c.offset, d.cdl.offset),
      power: vec(c.power, d.cdl.power),
      saturation: num(c.saturation, 1),
    },
    curves: {
      r: curve(cv.r, IDENTITY_CURVE),
      g: curve(cv.g, IDENTITY_CURVE),
      b: curve(cv.b, IDENTITY_CURVE),
      y: curve(cv.y, IDENTITY_CURVE),
      hueHue: curve(cv.hueHue, []),
      hueSat: curve(cv.hueSat, []),
      hueLum: curve(cv.hueLum, []),
      lumSat: curve(cv.lumSat, []),
      satSat: curve(cv.satSat, []),
    },
  };
}

/** Validates and completes a grade from JSON (unknown fields are dropped). */
export function normalizeGrade(input: unknown): Grade {
  const i = obj(input);
  const version = num(i.version, GRADE_VERSION);
  if (version > GRADE_VERSION) {
    throw new Error(
      `Grade version ${version} is newer than this player supports (${GRADE_VERSION})`,
    );
  }
  const nodes = Array.isArray(i.nodes) ? i.nodes.map((n, k) => normalizeNode(n, k)) : [];
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) n.id = newId();
    ids.add(n.id);
  }
  return { version: 1, enabled: i.enabled !== false, nodes };
}
