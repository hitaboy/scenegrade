# Architecture

## Layers

```
@scenelinear/element   <scenelinear-player> (Svelte compiled as a custom element, shadow DOM)
        │
@scenelinear/svelte    ScenePlayer = TopBar + ToolRail + Viewer + panels + Transport
        │              PlayerController bridges the Player to Svelte 5 runes ($state)
        │
@scenelinear/core      Player (state, cache, clock, prefetch, audio)
        ├── media/     FrameSource implementations: ExrSource, VideoSource, BrowserImageSource
        ├── gpu/       Renderer (decode + display passes), Surface (one per canvas), ScopeEngine
        ├── grade/     grade model, GPU interpreter (WGSL), CPU reference, undo history
        └── color/     input transforms, ACES view LUTs, CDL, .cube, false colour (CPU + WGSL)
        │
@scenelinear/exr-wasm  OpenEXRCore → WASM, ExrWorkerPool
mediabunny             demux (MOV/MP4/MKV/WebM), WebCodecs; @mediabunny/prores = TurboRes WASM
```

Each layer only uses the one below it. The core has no UI and no framework. Anything the Svelte UI
does can be done through the `Player` API.

## Frame pipeline

1. **Source → `FrameData`.** A source returns CPU pixels in one of these layouts:
   - `rgba-half`: EXR, interleaved RGBA float16 covering the data window.
   - `yuv`: planar Y'CbCr at 8/10/12 bits, 4:2:0, 4:2:2 or 4:4:4, optionally with alpha. This is
     the native output of ProRes and of software-decoded AV1/VP9.
   - `rgba8`: browser images and opaque hardware frames.
   - `external`: a `VideoFrame` or `ImageBitmap` used as a last resort.
2. **Frame cache (CPU).** A byte budget, by default 25 % of `deviceMemory` (512 MB to 4 GB). Eviction
   removes the frame _farthest from the playhead in the play direction_, not the least recently
   used one. The timeline cache bar is drawn from `cachedRanges()`.
3. **Decode pass (GPU, once per frame).** Uploads the planes (`r16uint` for 10/12-bit) and runs a
   fullscreen fragment shader:
   - converts YUV to RGB itself (matrix, limited/full range, co-sited 4:2:2 chroma interpolation);
   - applies the input transform (`sl_input`, generated per input space);
   - writes linear **ACEScg** to an `rgba16float` _scene texture_.

   Changing the input space re-runs only this pass, on the cached CPU frame.

4. **Display pass (GPU, per redraw).** Runs on every canvas:
   - **Viewport:** zoom and pan, data window vs display window, nearest filtering from 200 % up.
   - **Grade:** viewer exposure and saturation, then the node grade (`sl_grade`, see
     [grading.md](grading.md)), then CDL and an optional `.cube` LUT, both applied in ACEScct.
   - **Channel isolation.**
   - **View transform:** `ACEScg → ACEScct shaper → 3D LUT`, an exact trilinear interpolation with
     `textureLoad`.
   - **Overlays:** false colour, zebra, clipping, NaN/Inf, peaking, compare.

   For HDR views the signal is decoded (PQ/HLG → nits) and expressed relative to the reference
   white on an `rgba16float` canvas with `toneMapping: extended`.

5. **Scopes (GPU compute).** One dispatch over a sample grid at most 512 px wide evaluates the
   _same_ `displayChain()` WGSL as the viewer and accumulates histogram (with workgroup-local
   atomics), waveform (512 columns × 256 levels × 3 channels) and vectorscope (256²). Each scope
   canvas is drawn by a small fragment shader; graticules are SVG on top. Scopes refresh on every
   change while paused and at about 20 Hz during playback.

## Playback

- The **clock** is the audio hardware clock when audio is playing at 1× forward, and
  `performance.now()` otherwise.
- **Real time** mode shows the newest decoded frame not later than the clock and counts skipped
  frames. **All frames** mode waits for every frame and slides the clock.
- **Pre-roll:** `play()` holds the clock for up to 1.5 s until `max(4, 2 × parallelism)` frames
  ahead are decoded.
- **Prefetch** keeps `parallelism × 2` requests in flight (EXR) and wraps around in/out points
  when looping. Requests far behind the playhead after a seek are aborted.
- **`VideoSource`** uses two sequential decoding _cursors_ (Mediabunny iterators). A request is
  served by the cursor just behind it; otherwise the least recently used cursor seeks. While
  looping, one cursor finishes the end of the range and the other pre-decodes its start. Requests
  are served by priority, starting with the frame on screen.
- **ProRes** decodes through TurboRes inside Mediabunny's sequential iterator. It reaches 4K 422 HQ
  at 24 fps. Many parallel `getSample()` calls were about 25× slower, so they aren't used.

## Colour accuracy

- **Input transforms** are analytic. Their op chains and matrices are extracted from OCIO at bake
  time (`color/generated.ts`), and they are tested against OCIO fixtures to ≤ 4e-5.
- **View LUTs** are 49³ float16, with an ACEScct shaper domain of [0, 1.12557], which is linear 0 to 1024. Against exact OCIO the sRGB view measures ΔE2000 mean 0.16 / p99 0.80, and the HDR PQ
  views measure ΔE ITP mean ≈ 0.35. See [tools/ocio-bake/README.md](../tools/ocio-bake/README.md).
- **GPU vs CPU:** the WGSL was compiled with Dawn and compared with the CPU reference. The e2e test
  checks the final on-screen sRGB pixel of the 18 % patch against `applyViewCPU` (±2.5/255).
- **The pixel probe** reads the scene texture back from the GPU and evaluates the display value on
  the CPU with the same LUT.

## Why not …

| Option                              | Why not                                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCIO compiled to WASM at runtime    | Heavy (yaml-cpp, expat, minizip), and it generates no WGSL. Baking at build time gives the same numbers for free. A future optional `ocio-wasm` package could load custom configs. |
| `<video>` + `importExternalTexture` | 8-bit, browser colour conversion, no ProRes. Kept only as a fallback for opaque frames.                                                                                            |
| `SharedArrayBuffer` / threads       | Needs COOP/COEP headers on the host page, which breaks "embed anywhere". Decoders use worker pools and transferables instead.                                                      |
| Vite library mode for the element   | It inlines every `new URL(asset)` as base64, which would add about 8 MB of LUTs to the JS. A plain ES build emits LUTs and WASM as lazily loaded files instead.                    |
| WebGL2                              | No compute shaders or storage atomics, so the scopes would be far slower. WebGPU now ships in all major engines. A display-only WebGL2 fallback is on the roadmap.                 |
