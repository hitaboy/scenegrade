import { describe, expect, it } from 'vitest';
import {
  detectSequences,
  expandPattern,
  isSequencePattern,
  splitFrameNumber,
} from '../src/media/sequence';
import { framesToTimecode, timecodeToFrames } from '../src/player/timecode';
import { FrameCache } from '../src/player/cache';
import { rgbToRgb, PRIMARIES, apply } from '../src/gpu/matrices';
import type { FrameData } from '../src/media/types';

describe('sequences', () => {
  it('splits frame numbers', () => {
    expect(splitFrameNumber('shot_010.1001.exr')).toEqual({
      prefix: 'shot_010.',
      digits: '1001',
      ext: '.exr',
    });
    expect(splitFrameNumber('plate')).toBeNull();
  });
  it('groups files into sequences and reports gaps', () => {
    const names = [
      'a.1001.exr',
      'a.1003.exr',
      'a.1002.exr',
      'a.1005.exr',
      'b.0001.exr',
      'notes.txt',
    ];
    const seqs = detectSequences(names.map((name) => ({ name, src: name })));
    expect(seqs[0].pattern).toBe('a.####.exr');
    expect(seqs[0].items.map((i) => i.frame)).toEqual([1001, 1002, 1003, 1005]);
    expect(seqs[0].missing).toEqual([1004]);
    expect(seqs.find((s) => s.name === 'notes.txt')).toBeTruthy();
  });
  it('expands #### / %04d / $F4 patterns', () => {
    expect(isSequencePattern('x.####.exr')).toBe(true);
    expect(isSequencePattern('x.exr')).toBe(false);
    expect(expandPattern('s/x.####.exr', 9, 10).map((i) => i.src)).toEqual([
      's/x.0009.exr',
      's/x.0010.exr',
    ]);
    expect(expandPattern('x.%04d.exr', 1, 1)[0].src).toBe('x.0001.exr');
    expect(expandPattern('x.$F3.exr', 7, 7)[0].src).toBe('x.007.exr');
  });
});

describe('timecode', () => {
  it('round-trips non-drop timecode', () => {
    expect(framesToTimecode(0, 24)).toBe('00:00:00:00');
    expect(framesToTimecode(24 * 3600 + 25, 24)).toBe('01:00:01:01');
    expect(timecodeToFrames('01:00:01:01', 24)).toBe(24 * 3600 + 25);
  });
  it('handles 29.97 drop-frame', () => {
    // 1 minute of 29.97 DF = 1798 frames: 00:01:00;02 is the first frame of minute 1.
    expect(framesToTimecode(1800, 29.97)).toBe('00:01:00;02');
    expect(timecodeToFrames('00:01:00;02', 29.97)).toBe(1800);
    for (const f of [0, 17982, 107892, 53946])
      expect(timecodeToFrames(framesToTimecode(f, 29.97), 29.97)).toBe(f);
  });
});

describe('frame cache', () => {
  const frame = (index: number, bytes = 10): FrameData => ({
    index,
    bytes,
    decodeMs: 0,
    pixels: { kind: 'rgba8', width: 1, height: 1, data: new Uint8Array(4), hasAlpha: false },
  });
  it('evicts the frames farthest ahead of the playhead first', () => {
    const c = new FrameCache(30);
    c.put(frame(0), 0, 1, 100);
    c.put(frame(1), 0, 1, 100);
    c.put(frame(2), 0, 1, 100);
    c.put(frame(3), 1, 1, 100); // playhead at 1: frame 0 is "behind" (needs a loop) -> evicted
    expect(c.has(0)).toBe(false);
    expect([1, 2, 3].every((i) => c.has(i))).toBe(true);
    expect(c.ranges()).toEqual([[1, 3]]);
  });
  it('refuses a frame farther than everything cached', () => {
    const c = new FrameCache(20);
    c.put(frame(5), 5, 1, 100);
    c.put(frame(6), 5, 1, 100);
    expect(c.put(frame(50), 5, 1, 100)).toBe(false);
    expect(c.usedBytes).toBe(20);
  });
});

describe('colour matrices', () => {
  it('AP1 -> Rec.709 maps white to white and matches the known matrix', () => {
    const m = rgbToRgb(PRIMARIES.ap1, PRIMARIES.rec709);
    const w = apply(m, [1, 1, 1]);
    for (const v of w) expect(v).toBeCloseTo(1, 4);
    // Reference (Bradford, as in the ACES OCIO studio config): first row ≈ [1.705, -0.622, -0.083]
    expect(m[0]).toBeCloseTo(1.705, 2);
    expect(m[1]).toBeCloseTo(-0.622, 2);
  });
});

describe('Player.update', () => {
  it('keeps settings cloneable when given proxies (Svelte $state)', async () => {
    const g = globalThis as Record<string, unknown>;
    g.requestAnimationFrame ??= () => 0;
    g.cancelAnimationFrame ??= () => undefined;
    const { Player } = await import('../src/player/player');
    const p = new Player();
    const proxy = <T extends object>(o: T): T => new Proxy(o, {});
    const wipe = proxy({ ...p.settings.compare, mode: 'off' as const });
    p.update({ compare: wipe, cdl: proxy({ ...p.settings.cdl, slope: proxy([1, 2, 3]) as never }) });
    expect(() => structuredClone(p.settings)).not.toThrow();
    expect(p.settings.cdl.slope).toEqual([1, 2, 3]);
    p.dispose();
  });
});
