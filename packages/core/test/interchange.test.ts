import { describe, expect, it } from 'vitest';
import {
  cdlNode,
  defaultGrade,
  defaultNode,
  gradeFromJson,
  gradeToCdl,
  gradeToCube,
  gradeToJson,
  parseCdl,
  writeCdl,
  type Grade,
  type GradeNode,
} from '../src/grade/index';
import { parseCubeLut, type CDL } from '../src/color/grade';

const grade = (...edit: ((n: GradeNode) => void)[]): Grade => {
  const g = defaultGrade();
  g.nodes = edit.map((e) => {
    const n = defaultNode();
    e(n);
    return n;
  });
  return g;
};

const CDL_A: CDL = {
  slope: [1.1, 0.95, 1.02],
  offset: [0.01, -0.02, 0.005],
  power: [0.9, 1.05, 1],
  sat: 0.85,
};

describe('ASC CDL', () => {
  it('a CDL-only node exports exactly', () => {
    const r = gradeToCdl(grade((n) => Object.assign(n, cdlNode(CDL_A))));
    expect(r.exact).toBe(true);
    expect(r.cdl).toEqual(CDL_A);
    expect(r.error.max).toBeLessThan(1e-5);
  });

  it('an identity grade exports the identity CDL', () => {
    const r = gradeToCdl(defaultGrade());
    expect(r.exact).toBe(true);
    expect(r.cdl).toEqual({ slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 });
  });

  it('fits CDL-like primaries (gain, offset, contrast) to within a code value', () => {
    const r = gradeToCdl(
      grade((n) => {
        n.primaries.gain = [1.1, 1, 0.9, 1];
        n.primaries.offset = [0.01, 0, -0.01, 0];
        n.primaries.contrast = 1.15;
      }),
    );
    expect(r.exact).toBe(false);
    expect(r.error.maxCodeValues).toBeLessThan(1);
  });

  it('reports the error of a look a CDL cannot express', () => {
    const r = gradeToCdl(
      grade(
        (n) =>
          (n.curves.y = [
            [0, 0],
            [0.3, 0.45],
            [0.7, 0.6],
            [1, 1],
          ]),
      ),
    );
    expect(r.exact).toBe(false);
    expect(r.error.max).toBeGreaterThan(0.005);
  });

  it('writes .cc / .ccc / .cdl that read back the same values', () => {
    for (const format of ['cc', 'ccc', 'cdl'] as const) {
      const xml = writeCdl(CDL_A, { format, id: 'sh010' });
      expect(xml).toContain('urn:ASC:CDL:v1.01');
      const [p] = parseCdl(xml);
      expect(p.id).toBe('sh010');
      expect(p.cdl).toEqual(CDL_A);
    }
  });

  it('parses foreign CDLs: several corrections, missing SatNode, comma separators', () => {
    const xml = `<ColorCorrectionCollection xmlns="urn:ASC:CDL:v1.2">
      <ColorCorrection id="a"><SOPNode><Slope>1.2 1.0 0.8</Slope><Offset>0 0 0</Offset><Power>1 1 1</Power></SOPNode></ColorCorrection>
      <ColorCorrection id="b"><SOPNode><Slope>1,1,1</Slope></SOPNode><SatNode><Saturation>0.5</Saturation></SatNode></ColorCorrection>
    </ColorCorrectionCollection>`;
    const r = parseCdl(xml);
    expect(r.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r[0].cdl.sat).toBe(1);
    expect(r[1].cdl.slope).toEqual([1, 1, 1]);
    expect(r[1].cdl.power).toEqual([1, 1, 1]);
    expect(r[1].cdl.sat).toBe(0.5);
    expect(() => parseCdl('<xml/>')).toThrow();
    expect(() => parseCdl('<ColorCorrection><Slope>1 x 1</Slope></ColorCorrection>')).toThrow();
  });
});

describe('.cube', () => {
  it('bakes the grade with a small measured error, and parses back', () => {
    const g = grade((n) => {
      n.primaries.gain = [1.1, 1, 0.9, 1];
      n.primaries.saturation = 1.2;
      n.curves.y = [
        [0, 0],
        [0.4, 0.45],
        [1, 1],
      ];
    });
    const r33 = gradeToCube(g, { size: 33, title: 'test' });
    const lut = parseCubeLut(r33.text);
    expect(lut.size).toBe(33);
    expect(lut.title).toBe('test');
    expect(r33.error.maxCodeValues).toBeLessThan(4);
    const r65 = gradeToCube(g, { size: 65 });
    expect(r65.error.max).toBeLessThan(r33.error.max);
  });

  it('an identity grade bakes an identity LUT', () => {
    expect(gradeToCube(defaultGrade()).error.max).toBeLessThan(1e-5);
  });
});

describe('project JSON', () => {
  it('round-trips a grade exactly and also accepts a bare grade', () => {
    const g = grade(
      (n) => (n.primaries.lift = [0.01, 0, 0, 0.02]),
      (n) =>
        (n.curves.hueSat = [
          [0.1, 0.2],
          [0.6, -0.1],
        ]),
    );
    expect(gradeFromJson(gradeToJson(g))).toEqual(g);
    expect(gradeFromJson(JSON.stringify(g))).toEqual(g);
  });
});
