// SPDX-License-Identifier: Apache-2.0
// Look interchange: ASC CDL (.cc / .ccc / .cdl), 3D .cube and the native project JSON.
//
// Every exported look works in ACEScct (in and out), the usual working space for ACES looks:
// a viewer/grading tool applies   ACEScg → ACEScct → LOOK → ACEScct → ACEScg → view transform.

import { applyCDL, applyCubeCPU, parseCubeLut, type CDL } from '../color/grade.js';
import { acescctToACEScg, acescgToACEScct } from '../color/transfer.js';
import { applyGradeCPU } from './cpu.js';
import {
  defaultNode,
  isIdentityNode,
  nodeIs,
  normalizeGrade,
  type Grade,
  type GradeNode,
  type V3,
} from './model.js';
import { packGrade, type PackedGrade } from './pack.js';

/** The grade as a function ACEScct → ACEScct. */
function cctFunction(p: PackedGrade): (c: V3) => V3 {
  return (c) => acescgToACEScct(applyGradeCPU(p, acescctToACEScg(c)) as V3) as V3;
}

/** Error of an approximation, in ACEScct units (one 10-bit code value ≈ 0.001). */
export interface LookError {
  max: number;
  rms: number;
  /** Max error in 10-bit code values (max × 1023). */
  maxCodeValues: number;
}

// Deterministic samples over the ACEScct cube [0, 1]³ (LCG, so results are reproducible).
function samples(n: number): V3[] {
  let s = 12345;
  const r = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out: V3[] = [];
  for (let i = 0; i < n; i++) out.push([r(), r(), r()]);
  // Greys: CDL fits matter most on the neutral axis.
  for (let i = 0; i <= 64; i++) out.push([i / 64, i / 64, i / 64]);
  return out;
}

function measure(ref: (c: V3) => V3, approx: (c: V3) => V3, pts: V3[]): LookError {
  let max = 0;
  let sq = 0;
  for (const c of pts) {
    const a = ref(c);
    const b = approx(c);
    for (let k = 0; k < 3; k++) {
      const e = Math.abs(a[k] - b[k]);
      if (e > max) max = e;
      sq += e * e;
    }
  }
  const rms = Math.sqrt(sq / (pts.length * 3));
  return { max, rms, maxCodeValues: max * 1023 };
}

// ---------------------------------------------------------------------------------------------
// ASC CDL
// ---------------------------------------------------------------------------------------------

export interface CdlExport {
  cdl: CDL;
  /** True when the grade is exactly a CDL (one CDL-only node); otherwise `cdl` is a least-squares fit. */
  exact: boolean;
  error: LookError;
}

const cdlFromNode = (n: GradeNode): CDL => ({
  slope: [...n.cdl.slope] as V3,
  offset: [...n.cdl.offset] as V3,
  power: [...n.cdl.power] as V3,
  sat: n.cdl.saturation,
});

/** True when the node only uses its CDL stage (so it is exactly an ASC CDL). */
function isCdlOnly(n: GradeNode): boolean {
  const rest: GradeNode = { ...n, cdl: { ...n.cdl, enabled: false } };
  return n.mix === 1 && isIdentityNode(rest);
}

const toVec = (c: CDL) => [...c.slope, ...c.offset, ...c.power, c.sat];
const fromVec = (v: number[]): CDL => ({
  slope: [v[0], v[1], v[2]],
  offset: [v[3], v[4], v[5]],
  power: [v[6], v[7], v[8]],
  sat: v[9],
});

/** Nelder–Mead minimiser (small, dependency-free; enough for 10 smooth parameters). */
function nelderMead(f: (x: number[]) => number, x0: number[], step: number[], iters: number) {
  const n = x0.length;
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (j === i ? v + step[i] : v)))];
  let vals = simplex.map(f);
  for (let it = 0; it < iters; it++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    simplex = order.map((i) => simplex[i]);
    vals = order.map((i) => vals[i]);
    if (vals[n] - vals[0] <= 1e-14 * (1 + vals[0])) break;
    const c = x0.map((_, j) => simplex.slice(0, n).reduce((s, p) => s + p[j], 0) / n);
    const at = (t: number) => c.map((v, j) => v + t * (simplex[n][j] - v));
    const xr = at(-1);
    const fr = f(xr);
    if (fr < vals[0]) {
      const xe = at(-2);
      const fe = f(xe);
      [simplex[n], vals[n]] = fe < fr ? [xe, fe] : [xr, fr];
    } else if (fr < vals[n - 1]) {
      [simplex[n], vals[n]] = [xr, fr];
    } else {
      const xc = at(fr < vals[n] ? -0.5 : 0.5);
      const fc = f(xc);
      if (fc < Math.min(fr, vals[n])) [simplex[n], vals[n]] = [xc, fc];
      else {
        simplex = simplex.map((p) => p.map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])));
        vals = simplex.map(f);
      }
    }
  }
  const best = vals.indexOf(Math.min(...vals));
  return simplex[best];
}

/**
 * Expresses the grade as one ASC CDL (ACEScct in/out). Exact for a grade that is a single CDL
 * node; otherwise a least-squares fit, with its error measured over the ACEScct cube.
 */
export function gradeToCdl(g: Grade): CdlExport {
  const p = packGrade(g);
  const ref = cctFunction(p);
  const pts = samples(4000);
  const active = g.enabled ? g.nodes.filter((n) => !isIdentityNode(n)) : [];
  if (active.length === 0) {
    const cdl: CDL = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 };
    return { cdl, exact: true, error: measure(ref, (c) => applyCDL(c, cdl) as V3, pts) };
  }
  if (active.length === 1 && isCdlOnly(active[0]) && nodeIs.cdl(active[0])) {
    const cdl = cdlFromNode(active[0]);
    return { cdl, exact: true, error: measure(ref, (c) => applyCDL(c, cdl) as V3, pts) };
  }
  // Fit. Start from the affine fit of each channel on the grey axis.
  const fitPts = samples(200);
  const refs = fitPts.map(ref);
  const g0 = ref([0.2, 0.2, 0.2]);
  const g1 = ref([0.6, 0.6, 0.6]);
  const slope = [0, 1, 2].map((k) => (g1[k] - g0[k]) / 0.4);
  const offset = [0, 1, 2].map((k) => g0[k] - slope[k] * 0.2);
  const x0 = [...slope, ...offset, 1, 1, 1, 1];
  const P = new Float64Array(fitPts.flat());
  const R = new Float64Array(refs.flat());
  const cost = (v: number[]) => {
    let s = 0;
    for (let i = 0; i < P.length; i += 3) {
      let r = P[i] * v[0] + v[3];
      let g = P[i + 1] * v[1] + v[4];
      let b = P[i + 2] * v[2] + v[5];
      if (r > 0) r = r ** v[6];
      if (g > 0) g = g ** v[7];
      if (b > 0) b = b ** v[8];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      s +=
        (l + v[9] * (r - l) - R[i]) ** 2 +
        (l + v[9] * (g - l) - R[i + 1]) ** 2 +
        (l + v[9] * (b - l) - R[i + 2]) ** 2;
    }
    return s;
  };
  let x = x0;
  for (let round = 0; round < 3; round++)
    x = nelderMead(cost, x, [0.05, 0.05, 0.05, 0.02, 0.02, 0.02, 0.05, 0.05, 0.05, 0.05], 2000);
  const cdl = fromVec(x.map((v) => Math.round(v * 1e6) / 1e6));
  return { cdl, exact: false, error: measure(ref, (c) => applyCDL(c, cdl) as V3, pts) };
}

const f6 = (v: number) => {
  const s = v.toFixed(6);
  return s === '-0.000000' ? '0.000000' : s;
};
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ccXml(cdl: CDL, id: string, description: string[], indent: string): string {
  const v = (a: number[]) => a.map(f6).join(' ');
  return [
    `${indent}<ColorCorrection id="${esc(id)}">`,
    ...description.map((d) => `${indent}  <Description>${esc(d)}</Description>`),
    `${indent}  <SOPNode>`,
    `${indent}    <Slope>${v(cdl.slope)}</Slope>`,
    `${indent}    <Offset>${v(cdl.offset)}</Offset>`,
    `${indent}    <Power>${v(cdl.power)}</Power>`,
    `${indent}  </SOPNode>`,
    `${indent}  <SatNode>`,
    `${indent}    <Saturation>${f6(cdl.sat)}</Saturation>`,
    `${indent}  </SatNode>`,
    `${indent}</ColorCorrection>`,
  ].join('\n');
}

export type CdlFormat = 'cc' | 'ccc' | 'cdl';

/** Writes an ASC CDL file (.cc, .ccc or .cdl, schema v1.01). */
export function writeCdl(
  cdl: CDL,
  opts: { format: CdlFormat; id?: string; description?: string[] },
) {
  const id = opts.id ?? 'scenegrade';
  const desc = opts.description ?? ['Working space: ACEScct'];
  const head = '<?xml version="1.0" encoding="UTF-8"?>';
  const ns = 'xmlns="urn:ASC:CDL:v1.01"';
  if (opts.format === 'cc')
    return `${head}\n${ccXml(cdl, id, desc, '').replace('<ColorCorrection ', `<ColorCorrection ${ns} `)}\n`;
  if (opts.format === 'ccc')
    return `${head}\n<ColorCorrectionCollection ${ns}>\n${ccXml(cdl, id, desc, '  ')}\n</ColorCorrectionCollection>\n`;
  return `${head}\n<ColorDecisionList ${ns}>\n  <ColorDecision>\n${ccXml(cdl, id, desc, '    ')}\n  </ColorDecision>\n</ColorDecisionList>\n`;
}

export interface ParsedCdl {
  id: string;
  cdl: CDL;
}

/**
 * Reads every ColorCorrection in a .cc / .ccc / .cdl file (any ASC CDL schema version). Missing
 * nodes default to identity. Regex based, so it also runs in workers and Node.
 */
export function parseCdl(text: string): ParsedCdl[] {
  const out: ParsedCdl[] = [];
  const blocks = text.match(/<ColorCorrection\b[^>]*>[\s\S]*?<\/ColorCorrection>/g) ?? [];
  const nums = (block: string, tag: string, n: number, def: number): number[] => {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(block);
    if (!m) return Array(n).fill(def);
    const v = m[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (v.length !== n || v.some((x) => !Number.isFinite(x)))
      throw new Error(`Invalid <${tag}> in CDL: "${m[1].trim()}"`);
    return v;
  };
  for (const b of blocks) {
    const id = /<ColorCorrection\b[^>]*\bid="([^"]*)"/.exec(b)?.[1] ?? `cc${out.length + 1}`;
    out.push({
      id,
      cdl: {
        slope: nums(b, 'Slope', 3, 1) as V3,
        offset: nums(b, 'Offset', 3, 0) as V3,
        power: nums(b, 'Power', 3, 1) as V3,
        sat: nums(b, 'Saturation', 1, 1)[0],
      },
    });
  }
  if (out.length === 0) throw new Error('No <ColorCorrection> found in the CDL file');
  return out;
}

/** A grade node holding a CDL (for importing .cc / .ccc / .cdl). */
export function cdlNode(cdl: CDL, label = 'CDL'): GradeNode {
  const n = defaultNode(label);
  n.cdl = {
    enabled: true,
    slope: [...cdl.slope] as V3,
    offset: [...cdl.offset] as V3,
    power: [...cdl.power] as V3,
    saturation: cdl.sat,
  };
  return n;
}

// ---------------------------------------------------------------------------------------------
// .cube
// ---------------------------------------------------------------------------------------------

export interface CubeExport {
  text: string;
  /** Trilinear interpolation error of the LUT against the exact grade. */
  error: LookError;
}

/**
 * Bakes the grade into a 3D .cube (ACEScct in and out, domain 0–1: about −0.015 to 222 linear).
 * The interpolation error is measured on random ACEScct samples and reported.
 */
export function gradeToCube(g: Grade, opts: { size?: 33 | 65; title?: string } = {}): CubeExport {
  const n = opts.size ?? 33;
  const ref = cctFunction(packGrade(g));
  const lines = [
    `TITLE "${(opts.title ?? 'scenegrade look').replace(/"/g, "'")}"`,
    '# Input and output: ACEScct. Apply as ACEScg -> ACEScct -> LUT -> ACEScct -> ACEScg.',
    `LUT_3D_SIZE ${n}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ];
  for (let b = 0; b < n; b++)
    for (let gi = 0; gi < n; gi++)
      for (let r = 0; r < n; r++) {
        const o = ref([r / (n - 1), gi / (n - 1), b / (n - 1)]);
        lines.push(o.map(f6).join(' '));
      }
  const text = lines.join('\n') + '\n';
  const lut = parseCubeLut(text);
  const error = measure(ref, (c) => applyCubeCPU(lut, c) as V3, samples(6000));
  return { text, error };
}

// ---------------------------------------------------------------------------------------------
// Project JSON (exact, keeps every node)
// ---------------------------------------------------------------------------------------------

export function gradeToJson(g: Grade): string {
  return JSON.stringify({ format: 'scenegrade-grade', version: 1, grade: g }, null, 2) + '\n';
}

/** Accepts the project JSON written by `gradeToJson` or a bare grade object. */
export function gradeFromJson(text: string): Grade {
  const data = JSON.parse(text) as unknown;
  const g =
    data && typeof data === 'object' && 'grade' in data ? (data as { grade: unknown }).grade : data;
  return normalizeGrade(g);
}
