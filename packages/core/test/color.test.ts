// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ANALYTIC_VIEWS,
  COMMON_WGSL,
  CDL_WGSL,
  INPUT_SPACES,
  VIEWS,
  applyAnalyticViewCPU,
  applyCDL,
  applyCubeCPU,
  applyViewCPU,
  displayToNits,
  falseColorCPU,
  falseColorWGSL,
  findInputSpace,
  floatToHalf,
  halfToFloat,
  inputToACEScg,
  inputTransformWGSL,
  loadViewLut,
  parseCubeLut,
  pqEotf,
  pqOetf,
  hlgOetf,
  hlgInvOetf,
  srgbEotf,
  srgbOetf,
  type Vec3,
} from '../src/color/index';
import { summarize, viewDeltaE } from './color-metrics';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../tools/ocio-bake/fixtures/${name}`, import.meta.url), 'utf8'),
  );
const INPUT_FIX = fixture('input-spaces.json') as {
  spaces: { id: string; ocioName: string; input: Vec3[]; acescg: Vec3[] }[];
};
const VIEW_FIX = fixture('views.json') as {
  views: { id: string; acescg: Vec3[]; display_signal: Vec3[] }[];
  analytic: { id: 'srgb-clamp'; acescg: Vec3[]; display_signal: Vec3[] }[];
  decode: { encoding: string; display: string; signal: Vec3[]; nits: Vec3[] }[];
  cdl: { slope: Vec3; offset: Vec3; power: Vec3; sat: number; input: Vec3[]; output: Vec3[] }[];
};

describe('half floats', () => {
  it('round-trips every finite half exactly', () => {
    for (let h = 0; h < 65536; h++) {
      const f = halfToFloat(h);
      if (Number.isNaN(f)) continue;
      expect(floatToHalf(f)).toBe(h === 0x8000 ? 0x8000 : h);
    }
  });
  it('handles known values, rounding and specials', () => {
    expect(floatToHalf(1)).toBe(0x3c00);
    expect(floatToHalf(-2)).toBe(0xc000);
    expect(floatToHalf(65504)).toBe(0x7bff);
    expect(floatToHalf(65520)).toBe(0x7c00); // rounds to +Inf
    expect(floatToHalf(Infinity)).toBe(0x7c00);
    expect(floatToHalf(-Infinity)).toBe(0xfc00);
    expect(Number.isNaN(halfToFloat(floatToHalf(NaN)))).toBe(true);
    expect(floatToHalf(2 ** -24)).toBe(1); // smallest subnormal
    expect(floatToHalf(2 ** -26)).toBe(0); // underflow
    expect(floatToHalf(1 + 2 ** -11)).toBe(0x3c00); // tie -> even
    expect(floatToHalf(1 + 3 * 2 ** -11)).toBe(0x3c02); // tie -> even (up)
    expect(halfToFloat(0x3555)).toBeCloseTo(0.333251953125, 12);
  });
});

describe('input transforms vs OCIO', () => {
  it('covers every input space in the fixtures', () => {
    expect(INPUT_FIX.spaces.map((s) => s.id).sort()).toEqual(INPUT_SPACES.map((s) => s.id).sort());
    for (const id of [
      'acescg',
      'aces2065-1',
      'acescct',
      'acescc',
      'lin-rec709',
      'srgb',
      'rec709',
      'display-p3',
      'arri-logc3-ei800',
      'arri-logc4',
      'sony-slog3-sgamut3',
      'sony-slog3-sgamut3cine',
      'red-log3g10-rwg',
      'canon-clog2-cgamut',
      'canon-clog3-cgamut',
      'panasonic-vlog-vgamut',
      'bmd-film-wg-gen5',
      'apple-log',
      'davinci-intermediate-wg',
      'lin-p3d65',
      'lin-rec2020',
    ]) {
      expect(findInputSpace(id), id).toBeDefined();
    }
  });

  for (const sp of INPUT_FIX.spaces) {
    it(`${sp.id} (${sp.ocioName})`, () => {
      let worst = 0;
      sp.input.forEach((x, i) => {
        const ref = sp.acescg[i];
        const got = inputToACEScg(sp.id, x);
        // OCIO evaluates in float32: allow 1e-4 relative per channel plus float32 cancellation
        // relative to the largest channel of the pixel.
        const big = Math.max(...ref.map(Math.abs));
        for (let k = 0; k < 3; k++) {
          const err = Math.abs(got[k] - ref[k]) / (Math.max(Math.abs(ref[k]), 1) + 1e-2 * big);
          worst = Math.max(worst, err);
        }
      });
      expect(worst).toBeLessThan(1e-4);
    });
  }

  it('emits WGSL defining sl_input for every space', () => {
    for (const s of INPUT_SPACES) {
      const w = inputTransformWGSL(s.id);
      expect(w).toContain('fn sl_input(c_in: vec3f) -> vec3f');
      expect(w).not.toMatch(/NaN|Infinity|undefined/);
      expect(w.split('(').length).toBe(w.split(')').length);
      expect(w.split('{').length).toBe(w.split('}').length);
    }
    expect(() => inputTransformWGSL('nope')).toThrow();
  });
});

describe('view LUTs vs OCIO', () => {
  it('manifest has the expected views', () => {
    expect(VIEWS.length).toBeGreaterThanOrEqual(6);
    expect(VIEWS.map((v) => v.display)).toContain('sRGB - Display');
    expect(VIEWS.map((v) => v.display)).toContain('Rec.2100-PQ - Display');
  });

  for (const vf of VIEW_FIX.views) {
    it(`${vf.id}`, async () => {
      const lut = await loadViewLut(vf.id);
      expect(lut.data.length).toBe(lut.size ** 3 * 4);
      expect(halfToFloat(lut.data[3])).toBe(1);
      const de = vf.acescg.map((c, i) =>
        viewDeltaE(lut.info, applyViewCPU(lut, c), vf.display_signal[i]),
      );
      const s = summarize(de);
      console.log(
        `${vf.id}: dE mean ${s.mean.toFixed(3)} p99 ${s.p99.toFixed(3)} max ${s.max.toFixed(3)}`,
      );
      if (lut.info.hdr) {
        expect(s.mean).toBeLessThan(1); // Delta E ITP, 1 ~ JND
        expect(s.p99).toBeLessThan(5);
      } else {
        expect(s.mean).toBeLessThan(0.5); // CIEDE2000
        expect(s.p99).toBeLessThan(2);
      }
    });
  }

  it('accepts an explicit base URL', async () => {
    const base = new URL('../src/color/luts/', import.meta.url);
    const lut = await loadViewLut(VIEWS[0].id, base);
    expect(lut.size).toBe(VIEWS[0].size);
  });

  it('srgb-clamp analytic view matches OCIO Un-tone-mapped (in range)', () => {
    const a = VIEW_FIX.analytic.find((x) => x.id === 'srgb-clamp')!;
    expect(ANALYTIC_VIEWS.map((v) => v.id)).toContain('srgb-clamp');
    a.acescg.forEach((c, i) => {
      const ref = a.display_signal[i].map((v) => Math.min(Math.max(v, 0), 1));
      const got = applyAnalyticViewCPU('srgb-clamp', c);
      for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - ref[k])).toBeLessThan(2e-5);
    });
  });

  it('displayToNits matches OCIO display decoding', () => {
    for (const d of VIEW_FIX.decode) {
      d.signal.forEach((s, i) => {
        const got = displayToNits({ encoding: d.encoding as never }, s);
        for (let k = 0; k < 3; k++) {
          const ref = d.nits[i][k];
          expect(
            Math.abs(got[k] - ref) / Math.max(Math.abs(ref), 1),
            `${d.display} ${s}`,
          ).toBeLessThan(1e-4);
        }
      });
    }
  });
});

describe('transfer functions', () => {
  it('round-trip', () => {
    for (const x of [-0.5, -0.01, 0, 0.001, 0.0031308, 0.18, 0.5, 1, 4]) {
      expect(srgbEotf(srgbOetf(x))).toBeCloseTo(x, 10);
      expect(hlgInvOetf(hlgOetf(Math.abs(x) / 4))).toBeCloseTo(Math.abs(x) / 4, 10);
    }
    for (const n of [0, 0.01, 1, 100, 203, 1000, 10000])
      expect(pqEotf(pqOetf(n))).toBeCloseTo(n, 6);
    expect(pqOetf(10000)).toBeCloseTo(1, 12);
    expect(hlgOetf(1)).toBeCloseTo(1, 7);
  });
  it('COMMON_WGSL declares the documented helpers', () => {
    for (const fn of [
      'sl_acescg_to_acescct',
      'sl_acescct_to_acescg',
      'sl_srgb_oetf',
      'sl_srgb_eotf',
      'sl_pq_eotf',
      'sl_pq_oetf',
      'sl_hlg_oetf',
      'sl_hlg_inv_oetf',
      'sl_luma_ap1',
      'sl_luma709',
      'sl_lut_coord',
    ]) {
      expect(COMMON_WGSL).toContain(`fn ${fn}(`);
    }
    for (const m of [
      'AP1_TO_XYZ',
      'XYZ_TO_REC709',
      'XYZ_TO_P3D65',
      'XYZ_TO_REC2020',
      'REC2020_TO_P3D65',
    ]) {
      expect(COMMON_WGSL).toContain(`const ${m} = mat3x3f(`);
    }
    expect(COMMON_WGSL).not.toMatch(/NaN|Infinity|undefined/);
  });
});

describe('ASC CDL', () => {
  it('matches OCIO CDLTransform (CDL_NO_CLAMP)', () => {
    for (const f of VIEW_FIX.cdl) {
      f.input.forEach((x, i) => {
        const got = applyCDL(x, f);
        for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - f.output[i][k])).toBeLessThan(5e-6);
      });
    }
    expect(CDL_WGSL).toContain(
      'fn sl_cdl(c: vec3f, slope: vec3f, offset: vec3f, power: vec3f, sat: f32) -> vec3f',
    );
  });
});

describe('.cube parser', () => {
  it('parses a 3D cube with comments, title and domain', () => {
    const lines = [
      '# Resolve style',
      'TITLE "My LUT"',
      '',
      'LUT_3D_SIZE 2',
      'DOMAIN_MIN 0 0 0',
      'DOMAIN_MAX 1 1 1',
    ];
    for (let b = 0; b < 2; b++)
      for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${r} ${g} ${b} # c`);
    const lut = parseCubeLut(lines.join('\r\n'));
    expect(lut).toMatchObject({
      size: 2,
      is1D: false,
      title: 'My LUT',
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
    });
    expect(lut.data.length).toBe(32);
    expect(Array.from(lut.data.slice(4, 8))).toEqual([1, 0, 0, 1]); // r fastest
    expect(applyCubeCPU(lut, [0.25, 0.5, 0.75])).toEqual([0.25, 0.5, 0.75]);
  });
  it('parses a 1D cube with LUT_1D_INPUT_RANGE', () => {
    const txt = 'LUT_1D_SIZE 3\nLUT_1D_INPUT_RANGE -0.5 1.5\n0 0 0\n0.5 0.25 0.125\n1 1 1\n';
    const lut = parseCubeLut(txt);
    expect(lut).toMatchObject({
      size: 3,
      is1D: true,
      domainMin: [-0.5, -0.5, -0.5],
      domainMax: [1.5, 1.5, 1.5],
    });
    expect(applyCubeCPU(lut, [0.5, 0.5, 0.5])).toEqual([0.5, 0.25, 0.125]);
  });
  it('parses Resolve combined 1D shaper + 3D', () => {
    const l = [
      'LUT_1D_SIZE 2',
      'LUT_1D_INPUT_RANGE 0 2',
      'LUT_3D_SIZE 2',
      'LUT_3D_INPUT_RANGE 0 1',
      '0 0 0',
      '1 1 1',
    ];
    for (let i = 0; i < 8; i++) l.push(`${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`);
    const lut = parseCubeLut(l.join('\n'));
    expect(lut.is1D).toBe(false);
    expect(lut.shaper).toMatchObject({ size: 2, domainMax: [2, 2, 2] });
    const out = applyCubeCPU(lut, [1, 1, 1]);
    out.forEach((v) => expect(v).toBeCloseTo(0.5, 12));
  });
  it('rejects malformed files', () => {
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n')).toThrow();
    expect(() => parseCubeLut('0 0 0\n')).toThrow();
  });
});

describe('false colour', () => {
  it('generates WGSL and CPU bands', () => {
    expect(falseColorWGSL('arri-like')).toContain('fn sl_false_color(stops: f32) -> vec3f');
    expect(falseColorWGSL('el-zone')).toContain('fn sl_false_color(stops: f32) -> vec3f');
    expect(falseColorWGSL('ire')).toContain('fn sl_false_color_ire(ire: f32) -> vec3f');
    expect(falseColorCPU('arri-like', 0)).toEqual([0.25, 0.8, 0.25]);
    expect(falseColorCPU('el-zone', 10)).toEqual([1, 1, 1]);
    expect(falseColorCPU('ire', 101)).toEqual([1, 0, 0]);
  });
});
