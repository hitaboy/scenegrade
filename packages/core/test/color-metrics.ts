// SPDX-License-Identifier: Apache-2.0
// Colour-difference metrics for the colour tests (same definitions as tools/ocio-bake/bake.py).
import { MATRICES, displayToNits, pqOetf, type Vec3, type ViewInfo } from '../src/color/index';
import { mul3 } from '../src/color/math';

const TO_XYZ = {
  rec709: MATRICES.REC709_TO_XYZ,
  p3d65: MATRICES.P3D65_TO_XYZ,
  rec2020: MATRICES.REC2020_TO_XYZ,
};

function lab(xyz: Vec3, white: Vec3): Vec3 {
  const d = 6 / 29;
  const f = xyz.map((v, i) => {
    const r = v / white[i];
    return r > d ** 3 ? Math.cbrt(r) : r / (3 * d * d) + 4 / 29;
  });
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

export function de2000(l1: Vec3, l2: Vec3): number {
  const [L1, a1, b1] = l1;
  const [L2, a2, b2] = l2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h = (b: number, a: number) => (((Math.atan2(b, a) / rad) % 360) + 360) % 360;
  const h1p = h(b1, a1p);
  const h2p = h(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dh = h2p - h1p;
  if (C1p * C2p === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  const hs = h1p + h2p;
  let hbp = hs;
  if (C1p * C2p !== 0)
    hbp = Math.abs(h1p - h2p) <= 180 ? hs / 2 : hs < 360 ? (hs + 360) / 2 : (hs - 360) / 2;
  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * rad) +
    0.24 * Math.cos(2 * hbp * rad) +
    0.32 * Math.cos((3 * hbp + 6) * rad) -
    0.2 * Math.cos((4 * hbp - 63) * rad);
  const dth = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dth * rad) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

const LMS = [1688, 2146, 262, 683, 2951, 462, 99, 309, 3688].map((v) => v / 4096);
const ICTCP = [2048, 2048, 0, 6610, -13613, 7003, 17933, -17390, -543].map((v) => v / 4096);

function ictcp(nits2020: Vec3): Vec3 {
  const lms = mul3(LMS, nits2020.map((v) => Math.max(v, 0)) as Vec3).map(pqOetf) as Vec3;
  return mul3(ICTCP, lms);
}

/** SDR: CIEDE2000 (display CIELAB, D65, clipped to [0,1]); HDR: Delta E ITP (BT.2124). */
export function viewDeltaE(view: ViewInfo, a: Vec3, b: Vec3): number {
  const na = displayToNits(view, a);
  const nb = displayToNits(view, b);
  const M = TO_XYZ[view.primaries];
  if (!view.hdr) {
    const white = mul3(M, [1, 1, 1]);
    const c = (n: Vec3) => mul3(M, n.map((v) => Math.min(Math.max(v / 100, 0), 1)) as Vec3);
    return de2000(lab(c(na), white), lab(c(nb), white));
  }
  const to2020 = (n: Vec3) => mul3(MATRICES.XYZ_TO_REC2020, mul3(M, n));
  const ia = ictcp(to2020(na));
  const ib = ictcp(to2020(nb));
  return (
    720 * Math.sqrt((ia[0] - ib[0]) ** 2 + (0.5 * (ia[1] - ib[1])) ** 2 + (ia[2] - ib[2]) ** 2)
  );
}

export function summarize(d: number[]) {
  const s = [...d].sort((x, y) => x - y);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const p99 = s[Math.min(s.length - 1, Math.floor(0.99 * (s.length - 1)))];
  return { mean, p99, max: s[s.length - 1] };
}
