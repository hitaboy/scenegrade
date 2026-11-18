// SPDX-License-Identifier: Apache-2.0
// ExrWorkerPool in Node via @vitest/web-worker (simulated Web Workers, same thread).
import '@vitest/web-worker';
import { afterAll, describe, expect, test } from 'vitest';
import { ExrUnsupportedError, ExrWorkerPool, halfToFloat } from '../src/index.ts';
import { haveMedia, haveWasm, loadManifest, readMedia } from './helpers.ts';

describe.skipIf(!(haveMedia && haveWasm))('ExrWorkerPool', () => {
  const pool = new ExrWorkerPool({ size: 2 });
  afterAll(() => pool.dispose());

  test('default size', () => {
    const p = new ExrWorkerPool();
    expect(p.size).toBeGreaterThanOrEqual(1);
    expect(p.size).toBeLessThanOrEqual(8);
    p.dispose();
  });

  test('readInfo + decode, pixels match the manifest', async () => {
    const f = loadManifest().files.find((x) => x.path === 'chart_piz.exr')!;
    const bytes = readMedia(f.path);
    const info = await pool.readInfo(bytes);
    expect(info.parts[0].compression).toBe('PIZ');
    const d = await pool.decode(bytes);
    expect(d.pixels).toBeInstanceOf(Uint16Array);
    expect(d.pixels.length).toBe(f.width * f.height * 4);
    for (const s of f.samples) {
      const i = (s.y * d.width + s.x) * 4;
      expect(halfToFloat(d.pixels[i])).toBe(s.rgba[0]);
    }
    expect(bytes.length).toBeGreaterThan(0); // not detached by default
  });

  test('many concurrent decodes, priorities, transferInput', async () => {
    const seq = loadManifest().sequence!;
    const results = await Promise.all(
      seq.frames.slice(0, 8).map((fr, i) => {
        const b = readMedia(fr.path);
        return pool
          .decode(b.buffer as ArrayBuffer, { priority: i % 3, transferInput: true })
          .then((d) => [fr, d] as const);
      }),
    );
    for (const [fr, d] of results) {
      const s = fr.samples[0];
      const i = (s.y * d.width + s.x) * 4;
      expect(halfToFloat(d.pixels[i])).toBe(s.rgba[0]);
      expect(d.info.attributes.comments).toBe(`frame ${fr.frame}`);
    }
  });

  test('abort a queued job', async () => {
    const ac = new AbortController();
    const bytes = readMedia('bench_dwaa.exr');
    const jobs = [
      pool.decode(bytes),
      pool.decode(bytes),
      pool.decode(bytes, { signal: ac.signal }),
    ];
    ac.abort();
    await expect(jobs[2]).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.all(jobs.slice(0, 2));
    const pre = new AbortController();
    pre.abort();
    await expect(pool.decode(bytes, { signal: pre.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  test('errors propagate with their type', async () => {
    await expect(pool.decode(readMedia('deep.exr'))).rejects.toBeInstanceOf(ExrUnsupportedError);
    await expect(pool.decode(new Uint8Array(64))).rejects.toThrow(/cannot open EXR/);
  });
});
