// SPDX-License-Identifier: Apache-2.0
// IEEE 754 binary16 helpers (decoded EXR pixels are raw half bits by default).

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Convert raw half bits to a JS number (handles subnormals, Inf, NaN). */
export function halfToFloat(h: number): number {
  const s = (h & 0x8000) << 16;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) {
    const v = m * 2 ** -24; // subnormal / zero
    return s ? -v : v;
  }
  if (e === 31) u32[0] = s | 0x7f800000 | (m << 13);
  else u32[0] = s | ((e + 112) << 23) | (m << 13);
  return f32[0];
}

/** Convert a whole half buffer to float32. */
export function halfArrayToFloat32(
  src: Uint16Array,
  dst = new Float32Array(src.length),
): Float32Array {
  for (let i = 0; i < src.length; i++) dst[i] = halfToFloat(src[i]);
  return dst;
}
