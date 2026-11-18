// SPDX-License-Identifier: Apache-2.0
// Output (display/view) transforms. ACES view transforms are 3D LUTs baked offline with
// OpenColorIO (tools/ocio-bake/bake.py): ACEScg -> ACEScct (shaper) -> trilinear LUT ->
// display-encoded signal exactly as OCIO outputs it for that display/view.

import manifest from './luts/manifest.json' with { type: 'json' };
import { halfTable } from './half.js';
import { type Vec3, mul3 } from './math.js';
import { MATRICES } from './generated.js';
import {
  acescgToACEScct,
  hlgToNits,
  linToACEScct,
  pqEotf,
  powMirror,
  srgbEotf,
  srgbOetf,
} from './transfer.js';

export type DisplayEncoding = 'srgb' | 'bt1886' | 'gamma22' | 'gamma26' | 'pq' | 'hlg';
export type DisplayPrimaries = 'rec709' | 'p3d65' | 'rec2020';

export interface ViewInfo {
  id: string;
  display: string;
  view: string;
  label: string;
  size: number;
  hdr: boolean;
  peakNits: number;
  encoding: DisplayEncoding;
  primaries: DisplayPrimaries;
  file: string;
  /** Extra metadata (present in manifest.json). */
  ocioConfig?: string;
  bytes?: number;
  deltaE?: { mean: number; p99: number; max: number };
}

export interface ViewLut {
  size: number;
  /** float16 RGBA, r fastest (index = r + g*N + b*N*N), ready for a rgba16float 3D texture. */
  data: Uint16Array;
}

/** ACEScct domain of the LUT input axis: v = (acescct - min) / (max - min). */
export const VIEW_SHAPER: { space: 'acescct'; min: number; max: number } = manifest.shaper as never;
export const VIEWS: ViewInfo[] = manifest.views as ViewInfo[];
export const VIEWS_OCIO_CONFIG: string = manifest.ocioConfig;

export const ANALYTIC_VIEWS: { id: 'raw' | 'log-acescct' | 'srgb-clamp'; label: string }[] = [
  { id: 'raw', label: 'Raw (no transform)' },
  { id: 'log-acescct', label: 'Log (ACEScct)' },
  { id: 'srgb-clamp', label: 'Un-tone-mapped (sRGB, clipped)' },
];

export function findView(id: string): ViewInfo | undefined {
  return VIEWS.find((v) => v.id === id);
}

function defaultLutUrl(file: string): URL {
  // Template literal form so Vite can statically discover and emit the .bin assets.
  const name = file.replace(/\.bin$/, '');
  return new URL(`./luts/${name}.bin`, import.meta.url);
}

async function readBytes(url: URL): Promise<ArrayBuffer> {
  if (url.protocol === 'file:') {
    // Node (tests / SSR): fetch() cannot read file: URLs.
    const spec = 'node:fs/promises';
    const fs = (await import(/* @vite-ignore */ spec)) as typeof import('node:fs/promises');
    const buf = await fs.readFile(url);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load view LUT ${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Load a baked view LUT. By default the .bin is resolved next to this module
 * (`new URL('./luts/<file>', import.meta.url)`); pass `baseUrl` to host the LUTs elsewhere
 * (e.g. a CDN folder containing the files listed in manifest.json).
 */
export async function loadViewLut(
  id: string,
  baseUrl?: string | URL,
): Promise<{ info: ViewInfo; size: number; data: Uint16Array }> {
  const info = findView(id);
  if (!info) throw new Error(`Unknown view LUT: ${id}`);
  let url: URL;
  if (baseUrl !== undefined) {
    let base = String(baseUrl);
    if (!base.endsWith('/')) base += '/';
    const origin = typeof location !== 'undefined' ? location.href : import.meta.url;
    url = new URL(info.file, new URL(base, origin));
  } else {
    url = defaultLutUrl(info.file);
  }
  const buf = await readBytes(url);
  const n = info.size;
  if (buf.byteLength !== n * n * n * 8) {
    throw new Error(`View LUT ${id}: expected ${n * n * n * 8} bytes, got ${buf.byteLength}`);
  }
  return { info, size: n, data: new Uint16Array(buf) };
}

const decoded = new WeakMap<Uint16Array, Float32Array>();
function asFloat(data: Uint16Array): Float32Array {
  let f = decoded.get(data);
  if (!f) {
    const t = halfTable();
    f = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) f[i] = t[data[i]];
    decoded.set(data, f);
  }
  return f;
}

/**
 * CPU evaluation of a view LUT, bit-for-bit the same maths the GPU does with a linearly
 * filtered rgba16float 3D texture sampled at coord = (v*(N-1)+0.5)/N (texel centres).
 */
export function applyViewCPU(lut: ViewLut, acescg: Vec3): Vec3 {
  const n = lut.size;
  const f = asFloat(lut.data);
  const { min, max } = VIEW_SHAPER;
  const i0 = [0, 0, 0];
  const fr = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let v = (linToACEScct(acescg[k]) - min) / (max - min);
    v = Number.isNaN(v) ? 0 : Math.min(Math.max(v, 0), 1);
    const u = v * (n - 1);
    const i = Math.min(Math.floor(u), n - 2);
    i0[k] = i;
    fr[k] = u - i;
  }
  const out: Vec3 = [0, 0, 0];
  for (let db = 0; db < 2; db++) {
    const wb = db ? fr[2] : 1 - fr[2];
    for (let dg = 0; dg < 2; dg++) {
      const wg = dg ? fr[1] : 1 - fr[1];
      for (let dr = 0; dr < 2; dr++) {
        const w = (dr ? fr[0] : 1 - fr[0]) * wg * wb;
        if (w === 0) continue;
        const idx = 4 * (i0[0] + dr + (i0[1] + dg) * n + (i0[2] + db) * n * n);
        out[0] += w * f[idx];
        out[1] += w * f[idx + 1];
        out[2] += w * f[idx + 2];
      }
    }
  }
  return out;
}

/** CPU reference of the analytic views. */
export function applyAnalyticViewCPU(id: 'raw' | 'log-acescct' | 'srgb-clamp', acescg: Vec3): Vec3 {
  if (id === 'raw') return [acescg[0], acescg[1], acescg[2]];
  if (id === 'log-acescct') return acescgToACEScct(acescg);
  const l = mul3(MATRICES.AP1_TO_REC709, acescg).map((x) => srgbOetf(Math.min(Math.max(x, 0), 1)));
  return l as Vec3;
}

/**
 * Decode a display-encoded signal to absolute luminance per channel (nits), in the display's
 * own primaries. SDR encodings: 1.0 = 100 nits. Display P3 HDR (extended sRGB): 1.0 = 100 nits.
 * PQ: absolute (ST 2084). HLG: BT.2100 reference display, Lw = 1000 nits.
 */
export function displayToNits(view: Pick<ViewInfo, 'encoding'>, signal: Vec3): Vec3 {
  const s = signal;
  switch (view.encoding) {
    case 'srgb':
      return [100 * srgbEotf(s[0]), 100 * srgbEotf(s[1]), 100 * srgbEotf(s[2])];
    case 'bt1886':
    case 'gamma22':
    case 'gamma26': {
      const g = view.encoding === 'bt1886' ? 2.4 : view.encoding === 'gamma22' ? 2.2 : 2.6;
      return [100 * powMirror(s[0], g), 100 * powMirror(s[1], g), 100 * powMirror(s[2], g)];
    }
    case 'pq':
      return [pqEotf(s[0]), pqEotf(s[1]), pqEotf(s[2])];
    case 'hlg':
      return hlgToNits(s);
  }
}
