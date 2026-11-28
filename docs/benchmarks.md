# Benchmarks (phase 0 results)

These were measured on 2026-11-18 on an Apple M3 Pro MacBook Pro running macOS 26.5 and Chrome
stable with WebGPU (Metal), with no COOP/COEP (`crossOriginIsolated = false`). The media are the
generated test files (`pnpm media`). To reproduce, run `pnpm --filter @scenegrade/exr-wasm test`
for the decoder numbers, and use the demo's transport stats or `pnpm e2e` for playback.

## EXR decode (OpenEXR 3.4.9 → WASM, one worker, 1920×1080 RGBA half with grain)

| Compression | → half | → float |
| ----------- | ------ | ------- |
| ZIP         | 56 ms  | 62 ms   |
| PIZ         | 55 ms  | 64 ms   |
| DWAA        | 82 ms  | 89 ms   |
| DWAB        | 75 ms  | 81 ms   |
| HTJ2K (256) | 47 ms  | 55 ms   |

Most of the PIZ/DWA time goes to Huffman decoding inside OpenEXRCore; `-flto` and `-msse4.1`
made no difference. Throughput scales with the worker pool (`hardwareConcurrency − 2`, capped
at 8).

## Playback (real-time mode, measured over 4–7 s including loop points)

| Media                             | Decoder                     | Pixel format   | Playback    | Dropped  |
| --------------------------------- | --------------------------- | -------------- | ----------- | -------- |
| EXR sequence 1080p PIZ, 48 frames | OpenEXR WASM pool           | half RGBA      | 24.0 fps    | 0        |
| ProRes 422 HQ 1080p (ACEScct)     | TurboRes                    | I422P10        | 23.8–24 fps | 0        |
| ProRes 4444 XQ 1080p + alpha      | TurboRes                    | I444AP10       | 24 fps      | 0        |
| **ProRes 422 HQ UHD 3840×2160**   | TurboRes                    | I422P10        | **24 fps**  | 1 in 7 s |
| HEVC Main10 1080p                 | WebCodecs (hardware)        | opaque → RGBA8 | 24 fps      | 0        |
| AV1 10-bit 1080p                  | WebCodecs (software, dav1d) | I420P10        | 23.9 fps    | 0        |
| H.264 + AAC 1080p                 | WebCodecs                   | NV12           | 24 fps      | 0        |

Measured per-frame decode times: ProRes 1080p about 3–7 ms, ProRes UHD about 7 ms, EXR PIZ 1080p
about 29 ms per worker.

## Things we measured and rejected

- **Parallel ProRes via many `getSample()` calls:** about 184 ms per UHD frame, against about 7 ms
  for the sequential iterator, which already decodes in parallel internally. Not used.
- **Hardware LUT filtering:** weights are quantised to about 8 bits, giving up to 3.5e-3 error in
  steep regions. We use exact trilinear interpolation with `textureLoad` instead (8 loads; the cost
  is negligible).

- **10-bit readback of opaque hardware HEVC frames** (2026-11-28, Chrome on macOS, VideoToolbox):
  a 10-bit luma ramp gives 254 distinct levels through every path the browser offers —
  `VideoFrame.copyTo({ format: 'RGBA' })`, `copyExternalImageToTexture` into `rgb10a2unorm` or
  `rgba16float`, and `importExternalTexture`. Chrome has no software HEVC decoder to fall back to.
  So 10-bit HEVC shows 8-bit precision in Chrome on macOS; ProRes, AV1 and VP9 keep 10/12 bits.
  Recheck when Chrome exposes P010 planes for hardware frames.

## GPU budget

The display pass is a single fullscreen fragment shader: 1 or 2 texture loads, 8 LUT loads and
the overlays. Focus peaking adds 4 extra display-chain evaluations. Scopes run on a sample grid at
most 512 px wide, independent of the image resolution. GPU time per pass comes from timestamp queries
(`Renderer.timer`, summed in `state.stats.gpuMs` and shown in the transport bar when the browser
exposes `timestamp-query`). ProRes 422 HQ 1080p playback on the M3 Pro: decode 0.4 ms, display
0.3 ms, scopes 0.3 ms, about 1.1 ms per frame in total (Chrome quantises timestamps to 100 µs).
