// Colour wheel maths. The puck lives in a chroma plane oriented like the vectorscope
// (x = B − Y, y = R − Y, with ACES AP1 luma), so moving it changes colour but not luma.

const LR = 0.2722287168;
const LG = 0.6740817658;
const LB = 0.0536895174;

export type RGB = [number, number, number];

/** Puck (x, y) → zero-luma RGB delta. */
export function puckToRgb(x: number, y: number): RGB {
  const r = y;
  const b = x;
  const g = -(LR * r + LB * b) / LG;
  return [r, g, b];
}

/** RGB delta → puck (x, y) (its luma component is ignored). */
export function rgbToPuck(c: RGB): [number, number] {
  const yl = LR * c[0] + LG * c[1] + LB * c[2];
  return [c[2] - yl, c[0] - yl];
}

/** Display colour for a puck direction (for the hue ring and the puck), 0..1 sRGB-ish. */
export function puckColor(x: number, y: number): RGB {
  const c = puckToRgb(x, y);
  const m = Math.max(...c.map(Math.abs)) || 1;
  return c.map((v) => 0.5 + 0.42 * (v / m)) as RGB;
}

/** CSS conic-gradient for the hue ring, aligned with the puck plane. */
export function hueRingGradient(): string {
  const stops: string[] = [];
  for (let i = 0; i <= 36; i++) {
    const cssDeg = i * 10; // 0 = up, clockwise
    const a = ((90 - cssDeg) * Math.PI) / 180; // maths angle: 0 = +x, counter-clockwise
    const c = puckColor(Math.cos(a), Math.sin(a));
    stops.push(`rgb(${c.map((v) => Math.round(v * 255)).join(' ')}) ${cssDeg}deg`);
  }
  return `conic-gradient(${stops.join(', ')})`;
}
