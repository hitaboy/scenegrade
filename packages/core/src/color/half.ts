// SPDX-License-Identifier: Apache-2.0
// IEEE 754 binary16 <-> number conversion (round-to-nearest-even, subnormals, Inf, NaN).

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Decode a binary16 bit pattern (0..65535) to a number. */
export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24; // zero / subnormal
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Encode a number as a binary16 bit pattern, rounding to nearest even (same as GPU / numpy). */
export function floatToHalf(f: number): number {
  f32[0] = f; // rounds to f32 first (double rounding is harmless for f16 targets in practice)
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // Inf / NaN
  let e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00; // overflow -> Inf
  if (e <= 0) {
    // subnormal half (or zero)
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let hm = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && hm & 1)) hm++;
    return sign | hm; // may carry into exponent 1, which is still correct
  }
  let hm = mant >>> 13;
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && hm & 1)) {
    hm++;
    if (hm === 0x400) {
      hm = 0;
      e++;
      if (e >= 31) return sign | 0x7c00;
    }
  }
  return sign | (e << 10) | hm;
}

let table: Float32Array | undefined;
/** 65536-entry decode table (lazy). */
export function halfTable(): Float32Array {
  if (!table) {
    table = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) table[i] = halfToFloat(i);
  }
  return table;
}
