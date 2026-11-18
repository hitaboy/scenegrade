// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MEDIA_DIR = fileURLToPath(
  new URL('../../../apps/demo/public/media/generated/exr/', import.meta.url),
);
export const WASM_FILE = fileURLToPath(new URL('../dist-wasm/openexr.wasm', import.meta.url));

export type Expect = number | 'NaN' | 'Inf' | '-Inf';

export interface Sample {
  part: number;
  layer: string;
  x: number;
  y: number;
  rgba: Expect[];
}

export interface ManifestFile {
  path: string;
  kind: string;
  compression?: string;
  lossless?: boolean;
  referenceGroup?: string | null;
  tolRel?: number;
  tolAbs?: number;
  width: number;
  height: number;
  pixelType?: string;
  dataWindow?: { xMin: number; yMin: number; xMax: number; yMax: number };
  displayWindow?: { xMin: number; yMin: number; xMax: number; yMax: number };
  chromaticities?: number[];
  expectedLayers?: Record<string, (string | null)[]>;
  parts?: {
    name: string;
    type: string;
    compression: string;
    width: number;
    height: number;
    dataWindow?: object;
  }[];
  samples: Sample[];
}

export interface Manifest {
  files: ManifestFile[];
  sequence?: {
    pattern: string;
    first: number;
    last: number;
    width: number;
    height: number;
    frames: { path: string; frame: number; samples: Sample[] }[];
  };
}

export const haveMedia = existsSync(MEDIA_DIR + 'manifest.json');
export const haveWasm = existsSync(WASM_FILE);

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MEDIA_DIR + 'manifest.json', 'utf8')) as Manifest;
}

export function readMedia(path: string): Uint8Array {
  return new Uint8Array(readFileSync(MEDIA_DIR + path));
}

const HALF_MAX = 65504;
// values that round to +-Inf when converted to half (round to nearest even)
const HALF_OVERFLOW = 65520;

/** Compare a decoded value with an expected one; returns an error string or null. */
export function check(
  actual: number,
  expected: Expect,
  tolRel: number,
  tolAbs: number,
  half: boolean,
): string | null {
  if (expected === 'NaN') return Number.isNaN(actual) ? null : `expected NaN, got ${actual}`;
  if (expected === 'Inf') return actual === Infinity ? null : `expected +Inf, got ${actual}`;
  if (expected === '-Inf') return actual === -Infinity ? null : `expected -Inf, got ${actual}`;
  let e = expected;
  if (half && Math.abs(e) >= HALF_OVERFLOW) {
    const inf = e > 0 ? Infinity : -Infinity;
    return actual === inf ? null : `expected ${inf} (half overflow of ${e}), got ${actual}`;
  }
  if (half && Math.abs(e) > HALF_MAX) e = Math.sign(e) * HALF_MAX;
  if (Object.is(e, -0) && tolAbs === 0 && tolRel === 0 && !Object.is(actual, -0))
    return `expected -0, got ${actual}`;
  const tol = tolAbs + tolRel * Math.abs(e);
  return Math.abs(actual - e) <= tol ? null : `expected ${e} (±${tol}), got ${actual}`;
}
