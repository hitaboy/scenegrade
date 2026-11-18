// SPDX-License-Identifier: Apache-2.0
//
// Grouping of EXR channels into layers (AOVs).
//
// Rules:
//  * a channel name is split at its last '.': prefix = layer name, suffix = component;
//  * components R/G/B/A (any case, also red/green/blue/alpha), X/Y/Z, U/V are mapped
//    to the R, G, B, A outputs;
//  * a single-channel layer (e.g. 'depth.Z', or unprefixed 'Z') maps the same channel to
//    R, G and B, with A = null;
//  * the default layer '' gathers the unprefixed R, G, B, A channels, or a luminance /
//    chroma image (Y, RY, BY): Y is shown as grey (RY / BY are listed, not converted);
//  * every other unprefixed channel becomes its own single-channel layer named after it.

import type { ExrChannelMapping, ExrLayer } from './types.ts';

type Slot = 0 | 1 | 2 | 3;

const RGBA: Record<string, Slot> = {
  r: 0,
  red: 0,
  g: 1,
  green: 1,
  b: 2,
  blue: 2,
  a: 3,
  alpha: 3,
};
const XYZ: Record<string, Slot> = { x: 0, y: 1, z: 2 };
const UV: Record<string, Slot> = { u: 0, v: 1 };

function splitName(full: string): [prefix: string, comp: string] {
  const i = full.lastIndexOf('.');
  return i < 0 ? ['', full] : [full.slice(0, i), full.slice(i + 1)];
}

function single(name: string, channel: string): ExrLayer {
  return { name, channels: [channel], mapping: [channel, channel, channel, null], kind: 'single' };
}

function mapGroup(name: string, entries: [comp: string, full: string][]): ExrLayer {
  const channels = entries.map((e) => e[1]);
  if (entries.length === 1) return single(name, entries[0][1]);

  const lower = entries.map(([c, f]) => [c.toLowerCase(), f] as const);
  const has = (c: string) => lower.some(([l]) => l === c);
  const mapping: ExrChannelMapping = [null, null, null, null];
  const fill = (table: Record<string, Slot>): number => {
    let n = 0;
    for (const [l, f] of lower) {
      const slot = table[l];
      if (slot !== undefined && mapping[slot] === null) {
        mapping[slot] = f;
        n++;
      }
    }
    return n;
  };

  // luminance (+ alpha): Y without R/G/B/X/Z
  if (has('y') && !has('r') && !has('g') && !has('b') && !has('x') && !has('z')) {
    const y = lower.find(([l]) => l === 'y')![1];
    const a = lower.find(([l]) => l === 'a' || l === 'alpha');
    return { name, channels, mapping: [y, y, y, a ? a[1] : null], kind: 'luminance' };
  }
  if (fill(RGBA) > 0) {
    // an alpha-only match among other channels still counts as rgba
    if (mapping[0] || mapping[1] || mapping[2]) return { name, channels, mapping, kind: 'rgba' };
  }
  mapping.fill(null);
  if (fill(XYZ) > 0) return { name, channels, mapping, kind: 'xyz' };
  if (fill(UV) > 0) return { name, channels, mapping, kind: 'uv' };

  // unknown components: first channels in order to R, G, B (and a 4th to A)
  const m: ExrChannelMapping = [null, null, null, null];
  for (let i = 0; i < Math.min(4, channels.length); i++) m[i] = channels[i];
  if (channels.length === 2) m[2] = null;
  return { name, channels, mapping: m, kind: 'other' };
}

/** Group channel names into layers. The default layer '' (if any) comes first. */
export function groupLayers(channelNames: readonly string[]): ExrLayer[] {
  const groups = new Map<string, [string, string][]>();
  const unprefixed: string[] = [];
  for (const full of channelNames) {
    const [prefix, comp] = splitName(full);
    if (prefix === '') {
      unprefixed.push(full);
      continue;
    }
    let g = groups.get(prefix);
    if (!g) groups.set(prefix, (g = []));
    g.push([comp, full]);
  }

  const layers: ExrLayer[] = [];

  // default layer
  const byLower = new Map(unprefixed.map((c) => [c.toLowerCase(), c] as const));
  const pick = (...names: string[]) => {
    for (const n of names) {
      const c = byLower.get(n);
      if (c !== undefined) return c;
    }
    return null;
  };
  const used = new Set<string>();
  const r = pick('r', 'red');
  const g = pick('g', 'green');
  const b = pick('b', 'blue');
  const a = pick('a', 'alpha');
  if (r || g || b) {
    const mapping: ExrChannelMapping = [r, g, b, a];
    mapping.forEach((c) => c && used.add(c));
    layers.push({
      name: '',
      channels: mapping.filter((c): c is string => !!c),
      mapping,
      kind: 'rgba',
    });
  } else if (unprefixed.includes('Y')) {
    const chans = ['Y', 'RY', 'BY'].filter((c) => unprefixed.includes(c));
    if (a) chans.push(a);
    chans.forEach((c) => used.add(c));
    layers.push({ name: '', channels: chans, mapping: ['Y', 'Y', 'Y', a], kind: 'luminance' });
    // RY / BY are also exposed as single-channel layers so they can be inspected
    for (const c of ['RY', 'BY']) if (unprefixed.includes(c)) used.delete(c);
  }

  for (const c of unprefixed) if (!used.has(c)) layers.push(single(c, c));

  const named = [...groups.keys()].sort((x, y) => x.localeCompare(y));
  for (const name of named) {
    if (layers.some((l) => l.name === name)) continue; // unprefixed channel of same name already
    layers.push(mapGroup(name, groups.get(name)!));
  }
  return layers;
}

/** Default layer for display: '' if present, otherwise the first one. */
export function defaultLayer(layers: readonly ExrLayer[]): ExrLayer | undefined {
  return layers.find((l) => l.name === '') ?? layers[0];
}
