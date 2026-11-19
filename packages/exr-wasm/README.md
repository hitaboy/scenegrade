# @scenegrade/exr-wasm

OpenEXR decoding for the browser (and Node): the official **OpenEXRCore** C library
(OpenEXR **3.4.9**) compiled to WebAssembly with Emscripten, a small TypeScript API and a
Web Worker pool.

- Compressions: NONE, RLE, ZIPS, ZIP, PIZ, PXR24, B44, B44A, DWAA, DWAB, **HTJ2K256, HTJ2K32**
  (OpenJPH 0.26.3, vendored by OpenEXR).
- Scanline and tiled parts (tiled: level 0 of mip/rip maps), multipart, multi-layer (AOVs),
  subsampled channels (nearest upsampling), luminance/chroma files (Y shown as grey).
- Deep parts are detected (`type: 'deep'`, `supported: false`) and `decode` throws
  `ExrUnsupportedError`.
- Output: interleaved RGBA covering the data window, row 0 = `dataWindow.yMin`, as raw
  half bits (`Uint16Array`, ready for `rgba16float` textures) or `Float32Array`.
  Missing RGB channels = 0, missing alpha = 1.
- No threads, no `SharedArrayBuffer`: works without COOP/COEP. Parallelism comes from the
  worker pool (one wasm instance per worker). Pixel buffers are transferred, not copied.
- wasm: ~380 KB (~130 KB gzip), SIMD128, wasm exceptions (needed by OpenJPH).

## Usage

```ts
import { createExrDecoder, ExrWorkerPool } from '@scenegrade/exr-wasm';

// synchronous decoder (main thread, worker or Node)
const dec = await createExrDecoder();
const info = dec.readInfo(bytes); // { parts: [{ layers, channels, compression, ... }] }
const img = dec.decode(bytes, { part: 0, layer: 'diffuse', format: 'half' });

// worker pool (default size: max(1, hardwareConcurrency - 2), max 8)
const pool = new ExrWorkerPool();
const frame = await pool.decode('/shots/sh010.1001.exr', { priority: 10, signal });
pool.dispose();
```

`decode(src)` accepts an `ArrayBuffer`, a `Uint8Array` or a URL (fetched inside the
worker; relative URLs resolve against the document). `transferInput: true` hands the
caller's buffer to the worker instead of copying it. Aborting a queued job removes it;
aborting a running job cancels its fetch and rejects immediately.

Explicit channel mapping: `decode(bytes, { channels: ['Z', 'Z', 'Z', null] })`.

### Layers

Channel names are split at the last `.` (prefix = layer). Components `R/G/B/A`,
`r/g/b/a`, `red/green/blue/alpha`, `X/Y/Z`, `U/V` map to RGBA; a single-channel layer maps
the channel to R, G and B. Layer `''` holds the unprefixed R, G, B, A (or Y/RY/BY);
other unprefixed channels (`Z`, `depth`, ...) become single-channel layers of their own.

### wasm location

By default the decoder loads `new URL('../dist-wasm/openexr.wasm', import.meta.url)`, which
Vite (dev and build) and plain ESM resolve. Override with `wasmUrl` (e.g. a CDN URL). In
Node the file is read with `fs`.

## Building the wasm

Only Docker is required (image `emscripten/emsdk:6.0.13`, pinned in the script, as are the
OpenEXR tag/commit and the Imath tag):

```sh
packages/exr-wasm/scripts/build-wasm.sh          # -> dist-wasm/openexr.{mjs,wasm}
CLEAN=1 packages/exr-wasm/scripts/build-wasm.sh  # from scratch (re-clones OpenEXR)
```

`dist-wasm/` and `build/` are git-ignored. The C wrapper is `src-c/exr_wrapper.c`
(memory read callback + `exr_decoding_*` pipeline, header → JSON), linked by
`src-c/CMakeLists.txt` which adds OpenEXR as a sub-project (Core only, threading off).

## Tests and test media

```sh
uv run --python 3.12 --with OpenEXR --with numpy python tools/test-media/make_exr.py
pnpm --filter @scenegrade/exr-wasm test
```

The generator writes synthetic ACEScg images to `apps/demo/public/media/generated/exr/`
(git-ignored) plus `manifest.json` with known pixel values. The tests decode every file,
check those values, check that all lossless compressions decode bit-identical to NONE,
and run the worker pool through `@vitest/web-worker`. They are skipped (with a warning)
if the wasm or the media have not been generated. `test/bench.test.ts` prints decode
timings for 1920×1080 plates.

Known gaps: no mip/rip-map test file (the OpenEXR Python bindings cannot write them) and
subsampled channels are written by a small raw writer in the generator (uncompressed);
ZSTD (OpenEXR 3.5+) is not supported by OpenEXR 3.4.

## Third-party notices

The wasm binary contains code from:

| Component                                                                      | Version | License                                                                         |
| ------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------- |
| [OpenEXR](https://github.com/AcademySoftwareFoundation/openexr) (OpenEXRCore)  | 3.4.9   | BSD-3-Clause, © Contributors to the OpenEXR Project                             |
| [libdeflate](https://github.com/ebiggers/libdeflate) (vendored by OpenEXR)     | 1.25    | MIT, © 2016 Eric Biggers                                                        |
| [OpenJPH](https://github.com/aous72/OpenJPH) (vendored by OpenEXR, HTJ2K)      | 0.26.3  | BSD-2-Clause, © 2019 Aous Naman, Kakadu Software, University of New South Wales |
| [Imath](https://github.com/AcademySoftwareFoundation/Imath) (headers / config) | 3.2.2   | BSD-3-Clause, © Contributors to the OpenEXR Project                             |
| Emscripten runtime                                                             | 6.0.13  | MIT / University of Illinois NCSA                                               |

The build copies their license texts to `dist-wasm/licenses/`, which is published with the
package; keep them with any redistribution of the binary. This package itself is Apache-2.0.
