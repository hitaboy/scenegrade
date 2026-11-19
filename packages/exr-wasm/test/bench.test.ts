// SPDX-License-Identifier: Apache-2.0
// Decode timings for 1920x1080 RGBA "photographic" plates (chart + texture + grain).
// Prints a table; run alone with:  pnpm --filter @scenegrade/exr-wasm test bench
import { beforeAll, describe, expect, test } from 'vitest';
import { createExrDecoder, type ExrDecoder } from '../src/index.ts';
import { haveMedia, haveWasm, loadManifest, readMedia } from './helpers.ts';

const RUNS = Number(process.env.EXR_BENCH_RUNS ?? 7);

describe.skipIf(!(haveMedia && haveWasm))('decode benchmark (node)', () => {
  let dec: ExrDecoder;
  beforeAll(async () => {
    dec = await createExrDecoder();
  });

  test('1920x1080 RGBA half plates', () => {
    const rows: Record<string, string | number>[] = [];
    for (const f of loadManifest().files.filter((x) => x.kind === 'bench')) {
      const bytes = readMedia(f.path);
      for (const format of ['half', 'float'] as const) {
        dec.decode(bytes, { format }); // warm-up
        const ms: number[] = [];
        for (let i = 0; i < RUNS; i++) ms.push(dec.decode(bytes, { format }).decodeMs);
        ms.sort((a, b) => a - b);
        const med = ms[Math.floor(ms.length / 2)];
        rows.push({
          file: f.path,
          compression: f.compression!,
          out: format,
          'MB in': +(bytes.length / 1e6).toFixed(2),
          'median ms': +med.toFixed(1),
          'min ms': +ms[0].toFixed(1),
          fps: +(1000 / med).toFixed(1),
        });
      }
    }
    console.table(rows);
    expect(rows.length).toBeGreaterThan(0);
  });
});
