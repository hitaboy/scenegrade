// SPDX-License-Identifier: Apache-2.0
// False-colour exposure aids.
//
// Stop-based presets work on scene-linear luminance relative to 18% grey:
//   stops = log2(Y_ACEScg / 0.18)
// The IRE preset works on the display-referred signal in percent (0..100+ = code value * 100).
//
// 'arri-like' mimics the layout of ARRI's camera false colour (purple/blue near black,
// green at middle grey, pink around skin, yellow/red near clip) but is defined in scene stops,
// not in ARRI's LogC/video signal levels. 'el-zone' follows the style of the EL Zone System
// (1-stop bands from -6 to +6 around 18% grey); colours approximate the published chart and
// are not an official implementation. "ARRI" and "EL Zone System" are trademarks of their
// respective owners and are used only descriptively.

import { type Vec3, wf } from './math.js';

export interface FalseColorBand {
  stopMin: number;
  stopMax: number;
  color: Vec3;
  label: string;
}
export interface IreBand {
  ireMin: number;
  ireMax: number;
  color: Vec3;
  label: string;
}

const INF = Number.POSITIVE_INFINITY;
const g = (v: number): Vec3 => [v, v, v];

export const FALSE_COLOR_PRESETS: Record<'arri-like' | 'el-zone', FalseColorBand[]> = {
  'arri-like': [
    { stopMin: -INF, stopMax: -6.5, color: [0.5, 0.0, 0.65], label: 'Black clip' },
    { stopMin: -6.5, stopMax: -5.0, color: [0.0, 0.3, 1.0], label: 'Near black' },
    { stopMin: -5.0, stopMax: -3.5, color: [0.0, 0.55, 0.6], label: 'Deep shadow' },
    { stopMin: -3.5, stopMax: -1.5, color: g(0.18), label: 'Shadow' },
    { stopMin: -1.5, stopMax: -0.3, color: g(0.32), label: 'Low mid' },
    { stopMin: -0.3, stopMax: 0.3, color: [0.25, 0.8, 0.25], label: '18% grey' },
    { stopMin: 0.3, stopMax: 0.8, color: g(0.45), label: 'High mid' },
    { stopMin: 0.8, stopMax: 1.6, color: [1.0, 0.55, 0.7], label: 'Skin (~+1 stop)' },
    { stopMin: 1.6, stopMax: 3.5, color: g(0.65), label: 'Highlight' },
    { stopMin: 3.5, stopMax: 4.8, color: [1.0, 0.95, 0.1], label: 'Near clip' },
    { stopMin: 4.8, stopMax: 5.8, color: [1.0, 0.55, 0.0], label: 'Bright highlight' },
    { stopMin: 5.8, stopMax: INF, color: [1.0, 0.0, 0.0], label: 'Clip' },
  ],
  'el-zone': [
    { stopMin: -INF, stopMax: -6.5, color: [0.0, 0.0, 0.0], label: '< -6' },
    { stopMin: -6.5, stopMax: -5.5, color: [0.25, 0.0, 0.35], label: '-6' },
    { stopMin: -5.5, stopMax: -4.5, color: [0.45, 0.0, 0.7], label: '-5' },
    { stopMin: -4.5, stopMax: -3.5, color: [0.1, 0.1, 0.9], label: '-4' },
    { stopMin: -3.5, stopMax: -2.5, color: [0.0, 0.45, 0.9], label: '-3' },
    { stopMin: -2.5, stopMax: -1.5, color: [0.0, 0.6, 0.6], label: '-2' },
    { stopMin: -1.5, stopMax: -0.5, color: [0.0, 0.55, 0.15], label: '-1' },
    { stopMin: -0.5, stopMax: 0.5, color: g(0.5), label: '0 (18% grey)' },
    { stopMin: 0.5, stopMax: 1.5, color: [0.55, 0.8, 0.2], label: '+1' },
    { stopMin: 1.5, stopMax: 2.5, color: [1.0, 1.0, 0.0], label: '+2' },
    { stopMin: 2.5, stopMax: 3.5, color: [1.0, 0.7, 0.0], label: '+3' },
    { stopMin: 3.5, stopMax: 4.5, color: [1.0, 0.4, 0.0], label: '+4' },
    { stopMin: 4.5, stopMax: 5.5, color: [1.0, 0.0, 0.0], label: '+5' },
    { stopMin: 5.5, stopMax: 6.5, color: [1.0, 0.6, 0.75], label: '+6' },
    { stopMin: 6.5, stopMax: INF, color: [1.0, 1.0, 1.0], label: '> +6 (clip)' },
  ],
};

/** Broadcast-style false colour on the display signal, in % (code value * 100). */
export const IRE_FALSE_COLOR: IreBand[] = [
  { ireMin: -INF, ireMax: 2, color: [0.5, 0.0, 0.65], label: 'Black clip (< 2%)' },
  { ireMin: 2, ireMax: 10, color: [0.0, 0.3, 1.0], label: 'Near black (2-10%)' },
  { ireMin: 10, ireMax: 20, color: [0.0, 0.55, 0.6], label: 'Shadow (10-20%)' },
  { ireMin: 20, ireMax: 38, color: g(0.25), label: '20-38%' },
  { ireMin: 38, ireMax: 45, color: [0.25, 0.8, 0.25], label: 'Middle grey (38-45%)' },
  { ireMin: 45, ireMax: 55, color: g(0.45), label: '45-55%' },
  { ireMin: 55, ireMax: 65, color: [1.0, 0.55, 0.7], label: 'Skin (55-65%)' },
  { ireMin: 65, ireMax: 85, color: g(0.7), label: '65-85%' },
  { ireMin: 85, ireMax: 95, color: [1.0, 0.95, 0.1], label: 'Highlight (85-95%)' },
  { ireMin: 95, ireMax: 100, color: [1.0, 0.55, 0.0], label: 'Near clip (95-100%)' },
  { ireMin: 100, ireMax: INF, color: [1.0, 0.0, 0.0], label: 'Over 100%' },
];

export type FalseColorPreset = keyof typeof FALSE_COLOR_PRESETS | 'ire';

function bandsWGSL(fn: string, arg: string, bands: { max: number; color: Vec3 }[]): string {
  const body = bands
    .slice(0, -1)
    .map((b) => `  if (${arg} < ${wf(b.max)}) { return vec3f(${b.color.map(wf).join(', ')}); }`)
    .join('\n');
  const last = bands[bands.length - 1].color;
  return `fn ${fn}(${arg}: f32) -> vec3f {\n${body}\n  return vec3f(${last.map(wf).join(', ')});\n}\n`;
}

/**
 * WGSL for a false-colour preset. Stop presets define `fn sl_false_color(stops: f32) -> vec3f`
 * (stops = log2(Y / 0.18), scene-linear ACEScg luminance); 'ire' defines
 * `fn sl_false_color_ire(ire: f32) -> vec3f` (display signal in %). Output colours are
 * display-referred sRGB-encoded values, to be written directly to an SDR target.
 */
export function falseColorWGSL(preset: FalseColorPreset): string {
  if (preset === 'ire') {
    return bandsWGSL(
      'sl_false_color_ire',
      'ire',
      IRE_FALSE_COLOR.map((b) => ({ max: b.ireMax, color: b.color })),
    );
  }
  const bands = FALSE_COLOR_PRESETS[preset];
  if (!bands) throw new Error(`Unknown false colour preset: ${preset}`);
  return bandsWGSL(
    'sl_false_color',
    'stops',
    bands.map((b) => ({ max: b.stopMax, color: b.color })),
  );
}

/** CPU lookup (same banding as the WGSL). */
export function falseColorCPU(preset: FalseColorPreset, value: number): Vec3 {
  if (preset === 'ire')
    return (IRE_FALSE_COLOR.find((b) => value < b.ireMax) ?? IRE_FALSE_COLOR.at(-1)!).color;
  const bands = FALSE_COLOR_PRESETS[preset];
  return (bands.find((b) => value < b.stopMax) ?? bands.at(-1)!).color;
}
