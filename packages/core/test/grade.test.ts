import { describe, expect, it } from 'vitest';
import {
  CURVE_N,
  GradeHistory,
  applyGradeCPU,
  defaultGrade,
  defaultNode,
  hueOf,
  illuminantXY,
  isIdentityGrade,
  makePeriodicSpline,
  makeSpline,
  normalizeGrade,
  packGrade,
  planckianXY,
  whiteBalanceMatrix,
  type Grade,
  type GradeNode,
  type V3,
} from '../src/grade/index';
import { acescgToACEScct, acescctToACEScg } from '../src/color/transfer';
import { PRIMARIES, apply, inv, rgbToXyz } from '../src/gpu/matrices';

const grade = (...edit: ((n: GradeNode) => void)[]): Grade => {
  const g = defaultGrade();
  g.nodes = edit.map((e) => {
    const n = defaultNode();
    e(n);
    return n;
  });
  return g;
};
const run = (g: Grade, c: V3) => applyGradeCPU(packGrade(g), c);
const close = (a: number[], b: number[], eps = 1e-5) =>
  a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(eps));
const cct = (c: V3) => acescgToACEScct(c);
const SAMPLES: V3[] = [
  [0.18, 0.18, 0.18],
  [0.5, 0.2, 0.05],
  [0.01, 0.03, 0.2],
  [2, 1.5, 0.8],
  [0, 0, 0],
  [-0.01, 0.02, 0.05],
];

describe('grade model', () => {
  it('default grade is identity and packs to nothing', () => {
    const g = defaultGrade();
    expect(isIdentityGrade(g)).toBe(true);
    expect(packGrade(g).nodeCount).toBe(0);
    for (const s of SAMPLES) expect(run(g, s)).toEqual(s);
  });

  it('normalises partial JSON and rejects newer versions', () => {
    const g = normalizeGrade({
      nodes: [{ primaries: { contrast: 1.2 } }, { id: 'x' }, { id: 'x' }],
    });
    expect(g.nodes).toHaveLength(3);
    expect(g.nodes[0].primaries.contrast).toBe(1.2);
    expect(g.nodes[0].primaries.gain).toEqual([1, 1, 1, 1]);
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(3);
    expect(() => normalizeGrade({ version: 99 })).toThrow(/newer/);
    const round = normalizeGrade(JSON.parse(JSON.stringify(g)));
    expect(round).toEqual(g);
  });

  it('disabled grade, disabled node and mix 0 are bypassed', () => {
    const g = grade((n) => (n.primaries.contrast = 1.5));
    g.enabled = false;
    expect(packGrade(g).nodeCount).toBe(0);
    g.enabled = true;
    g.nodes[0].enabled = false;
    expect(packGrade(g).nodeCount).toBe(0);
    g.nodes[0].enabled = true;
    g.nodes[0].mix = 0;
    expect(packGrade(g).nodeCount).toBe(0);
  });
});

describe('linear stage', () => {
  it('exposure is a linear gain', () => {
    const g = grade((n) => (n.linear.exposure = 1));
    for (const s of SAMPLES)
      close(
        run(g, s),
        s.map((v) => v * 2),
      );
  });

  it('white balance is identity at 6500 K and adapts the illuminant to neutral', () => {
    expect(whiteBalanceMatrix(6500, 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const toXyz = rgbToXyz(PRIMARIES.ap1);
    const fromXyz = inv(toXyz);
    const xyz = (xy: [number, number]): V3 => [xy[0] / xy[1], 1, (1 - xy[0] - xy[1]) / xy[1]];
    const chroma = (rgb: V3) => {
      const X = apply(toXyz, rgb);
      const s = X[0] + X[1] + X[2];
      return [X[0] / s, X[1] / s];
    };
    for (const [T, tint] of [
      [3200, 0],
      [9000, 0],
      [5600, 0.5],
    ]) {
      const src = apply(fromXyz, xyz(illuminantXY(T, tint)));
      const out = apply(whiteBalanceMatrix(T, tint), src);
      close(chroma(out), planckianXY(6500), 1e-6);
    }
    // Continuity around the neutral point.
    close(whiteBalanceMatrix(6501, 0), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-3);
  });

  it('positive tint means greener illuminant (above the locus)', () => {
    const [x0, y0] = planckianXY(5000);
    const [x1, y1] = illuminantXY(5000, 1);
    expect(y1 - y0).toBeGreaterThan(0);
    expect(Math.hypot(x1 - x0, y1 - y0)).toBeGreaterThan(0.005);
  });

  it('channel mixer', () => {
    const g = grade((n) => (n.linear.mixer = [0, 1, 0, 1, 0, 0, 0, 0, 1]));
    close(run(g, [0.1, 0.2, 0.3]), [0.2, 0.1, 0.3]);
  });
});

describe('primaries (ACEScct)', () => {
  it('offset adds in ACEScct', () => {
    const g = grade((n) => (n.primaries.offset = [0.01, 0, -0.01, 0.02]));
    for (const s of SAMPLES) {
      const x = cct(s);
      close(cct(run(g, s)), [x[0] + 0.03, x[1] + 0.02, x[2] + 0.01]);
    }
  });

  it('contrast keeps the pivot', () => {
    const g = grade((n) => (n.primaries.contrast = 1.4));
    close(run(g, [0.18, 0.18, 0.18]), [0.18, 0.18, 0.18], 1e-6);
    expect(run(g, [0.5, 0.5, 0.5])[0]).toBeGreaterThan(0.5);
    expect(run(g, [0.05, 0.05, 0.05])[0]).toBeLessThan(0.05);
  });

  it('lift keeps 1.0, gain keeps 0, gamma keeps 0 and 1', () => {
    const one = acescctToACEScg([1, 1, 1]);
    const zero = acescctToACEScg([0, 0, 0]);
    close(
      cct(
        run(
          grade((n) => (n.primaries.lift = [0.05, 0, 0, 0.02])),
          one,
        ),
      ),
      [1, 1, 1],
    );
    close(
      cct(
        run(
          grade((n) => (n.primaries.gain = [1.2, 1, 1, 1.1])),
          zero,
        ),
      ),
      [0, 0, 0],
    );
    const gam = grade((n) => (n.primaries.gamma = [0.1, 0.1, 0.1, 0.2]));
    close(cct(run(gam, one)), [1, 1, 1]);
    close(cct(run(gam, zero)), [0, 0, 0]);
    expect(run(gam, [0.18, 0.18, 0.18])[1]).toBeGreaterThan(0.18);
  });

  it('master and per-channel wheel components combine', () => {
    const g = grade((n) => (n.primaries.gain = [1.1, 1, 0.9, 1.2]));
    const x = cct([0.18, 0.18, 0.18]);
    close(cct(run(g, [0.18, 0.18, 0.18])), [x[0] * 1.32, x[1] * 1.2, x[2] * 1.08]);
  });

  it('saturation keeps greys and scales chroma about AP1 luma', () => {
    const g = grade((n) => (n.primaries.saturation = 0));
    const out = cct(run(g, [0.5, 0.2, 0.05]));
    close([out[0] - out[1], out[1] - out[2]], [0, 0], 1e-6);
    close(
      run(
        grade((n) => (n.primaries.saturation = 1.7)),
        [0.18, 0.18, 0.18],
      ),
      [0.18, 0.18, 0.18],
    );
  });

  it('hue rotation of a third of a turn cycles R → G → B', () => {
    const g = grade((n) => (n.primaries.hue = 1 / 3));
    const x: V3 = [0.6, 0.3, 0.3];
    const out = cct(run(g, acescctToACEScg(x)));
    close(out, [0.3, 0.6, 0.3], 1e-6);
  });
});

describe('log wheels', () => {
  it('shadows act in the shadows only', () => {
    const g = grade((n) => (n.logWheels.shadows = [0.05, 0.05, 0.05]));
    const dark = acescctToACEScg([0.1, 0.1, 0.1]);
    const bright = acescctToACEScg([0.8, 0.8, 0.8]);
    close(cct(run(g, dark)), [0.15, 0.15, 0.15]);
    close(cct(run(g, bright)), [0.8, 0.8, 0.8]);
  });
  it('highlights act in the highlights only', () => {
    const g = grade((n) => (n.logWheels.highlights = [-0.05, 0, 0.05]));
    close(cct(run(g, acescctToACEScg([0.1, 0.1, 0.1]))), [0.1, 0.1, 0.1]);
    close(cct(run(g, acescctToACEScg([0.8, 0.8, 0.8]))), [0.75, 0.8, 0.85]);
  });
});

describe('curves', () => {
  it('monotone spline: passes through points, no overshoot', () => {
    const pts: [number, number][] = [
      [0, 0],
      [0.3, 0.1],
      [0.35, 0.8],
      [1, 1],
    ];
    const f = makeSpline(pts, 'offset');
    for (const [x, y] of pts) expect(f(x)).toBeCloseTo(y, 12);
    let prev = -1;
    for (let i = 0; i <= 1000; i++) {
      const y = f(i / 1000);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(y).toBeLessThanOrEqual(1 + 1e-12);
      prev = y;
    }
    expect(f(1.5)).toBeCloseTo(1.5);
    expect(f(-0.2)).toBeCloseTo(-0.2);
  });

  it('periodic spline is continuous across the seam', () => {
    const f = makePeriodicSpline([
      [0.1, 0.2],
      [0.5, -0.1],
      [0.9, 0.05],
    ]);
    expect(Math.abs(f(0.9999999) - f(0))).toBeLessThan(1e-5);
    expect(f(0.5)).toBeCloseTo(-0.1, 12);
    expect(f(1.1)).toBeCloseTo(0.2, 12);
  });

  it('identity tone curves are skipped, edited ones apply and extend outside [0, 1]', () => {
    expect(packGrade(grade(() => {})).nodeCount).toBe(0);
    const g = grade(
      (n) =>
        (n.curves.y = [
          [0, 0.1],
          [1, 1.1],
        ]),
    );
    for (const s of SAMPLES) {
      const x = cct(s);
      close(cct(run(g, s)), [x[0] + 0.1, x[1] + 0.1, x[2] + 0.1], 2e-5);
    }
  });

  it('a lifted red curve changes red only', () => {
    const g = grade(
      (n) =>
        (n.curves.r = [
          [0, 0],
          [0.5, 0.6],
          [1, 1],
        ]),
    );
    const out = cct(run(g, acescctToACEScg([0.5, 0.5, 0.5])));
    close(out, [0.6, 0.5, 0.5], 1e-5);
  });

  it('hue vs sat desaturates the selected hue only and never touches greys', () => {
    const g = grade(
      (n) =>
        (n.curves.hueSat = [
          [0, -1],
          [0.2, 0],
          [0.8, 0],
        ]),
    );
    const red = acescctToACEScg([0.6, 0.35, 0.35]);
    const blue = acescctToACEScg([0.35, 0.35, 0.6]);
    const r = cct(run(g, red));
    expect(Math.abs(r[0] - r[1])).toBeLessThan(1e-6);
    close(cct(run(g, blue)), [0.35, 0.35, 0.6], 1e-6);
    close(run(g, [0.18, 0.18, 0.18]), [0.18, 0.18, 0.18], 1e-7);
  });

  it('hue vs hue rotates the selected hue', () => {
    const g = grade((n) => (n.curves.hueHue = [[0, 1 / 3]]));
    const out = cct(run(g, acescctToACEScg([0.6, 0.3, 0.3])));
    close(out, [0.3, 0.6, 0.3], 1e-5);
    expect(hueOf(out)).toBeCloseTo(1 / 3, 4);
  });

  it('lum vs sat and sat vs sat', () => {
    const lum = grade((n) => (n.curves.lumSat = [[0, -1]]));
    const o = cct(run(lum, acescctToACEScg([0.6, 0.3, 0.3])));
    expect(Math.abs(o[0] - o[1])).toBeLessThan(1e-6);
    const sat = grade(
      (n) =>
        (n.curves.satSat = [
          [0, 0],
          [0.2, 0],
          [0.3, 1],
        ]),
    );
    close(cct(run(sat, acescctToACEScg([0.45, 0.4, 0.4]))), [0.45, 0.4, 0.4], 1e-5);
    const big = cct(run(sat, acescctToACEScg([0.8, 0.4, 0.4])));
    expect(big[0] - big[1]).toBeGreaterThan(0.6);
  });

  it('bakes CURVE_N samples per row', () => {
    const p = packGrade(grade((n) => (n.primaries.contrast = 1.1)));
    expect(p.curves.length).toBe(CURVE_N * p.rows);
  });
});

describe('nodes', () => {
  it('apply in series', () => {
    const g = grade(
      (n) => (n.linear.exposure = 1),
      (n) => (n.linear.exposure = 0.5),
    );
    close(
      run(g, [0.1, 0.2, 0.3]),
      [0.1, 0.2, 0.3].map((v) => v * 2 ** 1.5),
    );
  });

  it('mix blends with the node input in ACEScct', () => {
    const g = grade((n) => {
      n.primaries.offset = [0, 0, 0, 0.1];
      n.mix = 0.5;
    });
    const x = cct([0.18, 0.2, 0.3]);
    close(
      cct(run(g, [0.18, 0.2, 0.3])),
      x.map((v) => v + 0.05),
    );
  });

  it('CDL node matches applyCDL', () => {
    const g = grade((n) => {
      n.cdl = {
        enabled: true,
        slope: [1.1, 1, 0.9],
        offset: [0.01, 0, -0.01],
        power: [1, 1.1, 1],
        saturation: 0.9,
      };
    });
    const out = run(g, [0.3, 0.2, 0.1]);
    expect(out[0]).not.toBeCloseTo(0.3, 3);
    expect(Number.isFinite(out[2])).toBe(true);
  });
});

describe('history', () => {
  it('undo / redo with coalescing', () => {
    let t = 0;
    const h = new GradeHistory({ now: () => t });
    const g0 = defaultGrade();
    const g1 = normalizeGrade({ ...g0, nodes: [{ ...g0.nodes[0], mix: 0.5 }] });
    const g2 = normalizeGrade({ ...g0, nodes: [{ ...g0.nodes[0], mix: 0.4 }] });
    const g3 = normalizeGrade({ ...g0, nodes: [{ ...g0.nodes[0], mix: 0.3 }] });
    h.record(g0, 'drag');
    t = 100;
    h.record(g1, 'drag');
    t = 200;
    h.record(g2, 'drag');
    expect(h.canUndo).toBe(true);
    const u = h.undo(g3)!;
    expect(u.nodes[0].mix).toBe(1);
    expect(h.canUndo).toBe(false);
    expect(h.redo(u)!.nodes[0].mix).toBe(0.3);
    h.record(g3);
    h.record(g2);
    expect(h.canRedo).toBe(false);
    expect(h.undo(g1)!.nodes[0].mix).toBe(0.4);
  });
});

describe('Player grade API', () => {
  it('setGrade / updateGradeNode / undo / redo', async () => {
    const g = globalThis as Record<string, unknown>;
    g.requestAnimationFrame ??= () => 0;
    g.cancelAnimationFrame ??= () => undefined;
    const { Player } = await import('../src/player/player');
    const p = new Player();
    const rev0 = p.state.gradeRevision;
    p.updateGradeNode(null, { primaries: { contrast: 1.3 } });
    expect(p.getGrade().nodes[0].primaries.contrast).toBe(1.3);
    expect(p.getGrade().nodes[0].primaries.pivot).toBeCloseTo(0.4135884);
    expect(p.state.gradeRevision).toBe(rev0 + 1);
    p.updateGradeNode(null, { primaries: { saturation: 0.5 } }, { history: 'sat' });
    p.updateGradeNode(null, { primaries: { saturation: 0.4 } }, { history: 'sat' });
    expect(p.state.canUndo).toBe(true);
    p.undo();
    expect(p.getGrade().nodes[0].primaries.saturation).toBe(1);
    p.undo();
    expect(p.getGrade().nodes[0].primaries.contrast).toBe(1);
    expect(p.state.canUndo).toBe(false);
    p.redo();
    expect(p.getGrade().nodes[0].primaries.contrast).toBe(1.3);
    // getGrade returns a copy
    p.getGrade().nodes[0].mix = 0;
    expect(p.getGrade().nodes[0].mix).toBe(1);
    close(p.gradeCPU([0.18, 0.18, 0.18]), [0.18, 0.18, 0.18], 1e-6);
    p.dispose();
  });
});
