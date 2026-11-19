# ocio-bake

Offline bake of the scenegrade colour pipeline from the official built-in ACES OpenColorIO
configs. The browser never runs OCIO: input transforms are analytic (TS + WGSL generated from
the op chains OCIO itself uses) and ACES view transforms are 3D LUTs.

## Rebake

From the repo root (needs [uv](https://docs.astral.sh/uv/); wheels exist for py3.12 macOS arm64):

```sh
uv run --python 3.12 --with opencolorio --with numpy python tools/ocio-bake/bake.py
# or: pnpm bake:luts
# options: --size N (default 49), --eval-only (report accuracy, write nothing), --samples N
```

Outputs:

| Path | Content |
| --- | --- |
| `packages/core/src/color/luts/<id>.bin` | 3D LUT, raw little-endian float16 RGBA (A = 1), r fastest (`r + g*N + b*N*N`), uploadable as-is to an `rgba16float` 3D texture (`bytesPerRow = N*8`, `rowsPerImage = N`) |
| `packages/core/src/color/luts/manifest.json` | per-view metadata (OCIO names, encoding, primaries, peak, size, bytes, measured ΔE) + shaper domain |
| `packages/core/src/color/generated.ts` | input-space op chains, all matrices, OCIO config/version, shaper constants |
| `tools/ocio-bake/fixtures/input-spaces.json` | ~200 encoded samples per input space + OCIO result in ACEScg |
| `tools/ocio-bake/fixtures/views.json` | ~550 ACEScg samples per view (grey ramp −14…+12 stops, AP1/Rec.709 primaries & secondaries, skin, up to 65504, negatives, random) + OCIO display signal; Un-tone-mapped, display decoding and ASC CDL references |

The script also checks its own Python reimplementation of every input chain and display
decode against OCIO and prints the max error. Then run `pnpm --filter @scenegrade/core test`.

Optional GPU check (compiles all WGSL with Dawn and compares GPU vs CPU, incl. LUT sampling):
`cd "$(mktemp -d)" && npm i webgpu tsx && npx tsx <repo>/tools/ocio-bake/gpu-check.mts`.

## Source configs

- Main: `ocio://studio-config-latest` = `studio-config-v5.0.0_aces-v2.1_ocio-v2.6` (OpenColorIO 2.6.0 from PyPI).
- Legacy (ACES 1.x comparison only): `studio-config-v2.2.0_aces-v1.3_ocio-v2.4`.
- Chromatic adaptation: the config uses **Bradford** (D60 ↔ D65); all matrices in
  `generated.ts`/`COMMON_WGSL` are taken from OCIO, so they match it exactly.

## LUT design

GPU path: `ACEScg → ACEScct (analytic) → normalise to [0,1] over ACEScct [0, 1.12557]
→ trilinear 3D LUT → display-encoded signal`, exactly what OCIO outputs for
`DisplayViewTransform(src=ACEScct, display, view)` (incl. its range clamps). Texel-centre
sampling: `coord = (v*(N-1)+0.5)/N` (`sl_lut_coord`), or exact `sl_lut_trilinear` with
`textureLoad` (hardware filtering quantises the weights to ~8 bits on many GPUs: up to ~2e-3
signal error in steep regions; the textureLoad path matches the CPU reference to ~1e-5).

- Domain: ACEScct 0.0 (linear −0.0069) … ACEScct(1024) = 1.12557. 1024 is where the ACES 2.0
  SDR output clamps its AP0 input; HDR clamps at 4096 but 1024…4096 is flat at the shoulder.
- Size **49** (0.94 MB/view). 33 already met the SDR target (natural mean 0.30 / p99 1.31),
  65 halves the error again (SDR mean 0.10 / p99 0.57) at 2.2 MB/view; 49 is the
  compromise. 8 views = **7,529,536 bytes** in total.

### Accuracy (LUT trilinear on float16 data vs exact OCIO, 50k random samples)

Metric: SDR = CIEDE2000 in display-referred CIELAB (signal decoded with the display EOTF,
clipped to [0,1], D65, display white = L\*100). HDR = ΔE ITP (ITU-R BT.2124) on absolute
luminance (PQ: ST 2084; HLG: BT.2100 reference display 1000 nits; Display P3 HDR: 1.0 =
100 nits extended sRGB) — 1 ΔE ITP ≈ 1 JND, it is the standard HDR metric and handles
>100-nit levels that CIELAB cannot. "natural" = Rec.709-gamut colours at −8…+8 stops around
18% grey; "cube" = uniform in the ACEScct LUT domain (stress test with extreme AP1 saturation).

| id | display | view | natural mean / p99 / max | cube mean / p99 |
| --- | --- | --- | --- | --- |
| srgb-aces2-sdr709 | sRGB - Display | ACES 2.0 - SDR 100 nits (Rec.709) | 0.158 / 0.803 / 1.376 | 0.071 / 0.655 |
| rec1886-aces2-sdr709 | Rec.1886 Rec.709 - Display | ACES 2.0 - SDR 100 nits (Rec.709) | 0.154 / 0.779 / 1.391 | 0.071 / 0.665 |
| displayp3-aces2-sdrp3 | Display P3 - Display | ACES 2.0 - SDR 100 nits (P3 D65) | 0.137 / 0.779 / 1.309 | 0.074 / 0.664 |
| pq-aces2-hdr1000-p3 | Rec.2100-PQ - Display | ACES 2.0 - HDR 1000 nits (P3 D65) | 0.359 / 1.584 / 6.842 | 0.358 / 3.638 |
| pq-aces2-hdr1000-rec2020 | Rec.2100-PQ - Display | ACES 2.0 - HDR 1000 nits (Rec.2020) | 0.318 / 1.463 / 3.752 | 0.503 / 5.984 |
| displayp3hdr-aces2-hdr1000-p3 | Display P3 HDR - Display | ACES 2.0 - HDR 1000 nits (P3 D65) | 0.508 / 1.863 / 6.564 | 0.342 / 3.303 |
| hlg-aces2-hdr1000-p3 | Rec.2100-HLG - Display | ACES 2.0 - HDR 1000 nits (P3 D65) | 0.372 / 1.572 / 5.819 | 0.367 / 3.521 |
| srgb-aces1-sdrvideo | sRGB - Display | ACES 1.0 - SDR Video (legacy config) | 0.120 / 0.810 / 1.816 | 0.054 / 0.405 |

SDR target (mean < 0.5, p99 < 2) is met. "Un-tone-mapped" is not baked: it is the analytic
view `srgb-clamp` (ACEScg → Rec.709 matrix → clip → sRGB), verified against OCIO.

### Input spaces

All verified against OCIO (max error per channel ≤ 4e-5 of max(|value|, 1); the residual is
OCIO's own float32 / 1D-LUT evaluation. ACEScc pixels with extreme channel ratios also show
OCIO float32 cancellation in its AP1→AP0→clamp→AP1 round trip, so the test tolerance adds
1e-2 × the largest channel of the pixel to the denominator). ACEScc, Apple Log (2) and Canon Log 2/3 are 1D LUTs inside OCIO;
we use the closed-form curves and replicate OCIO's input clamps (ACEScc [−0.36, 1.5] and the
AP0 ≥ 0 clamp, Canon [0, 1]). Note OCIO's ACEScc does not apply the 65504 cap.

## Licences and notices

- **ACES**: the ACES output/input transforms and the ACES OCIO configs are © Academy of
  Motion Picture Arts and Sciences / ASWF, distributed under the ACES licence
  (<https://github.com/ampas/aces-dev/blob/main/LICENSE.md>) and the OCIO configs'
  BSD-3-Clause licence (<https://github.com/AcademySoftwareFoundation/OpenColorIO-Config-ACES>).
  The LUTs here are derived works (sampled evaluations) of those transforms; keep this notice
  when redistributing them. "ACES" is a trademark of the Academy (A.M.P.A.S.); use of the name
  for products requires following the Academy's logo/trademark programme. scenegrade is not
  endorsed by or affiliated with the Academy.
- **OpenColorIO**: © Contributors to the OpenColorIO Project, BSD-3-Clause. Used only at bake
  time; no OCIO code ships in the player.
- Camera log curves/gamuts are as published by the respective manufacturers (ARRI, Sony, RED,
  Canon, Panasonic, Blackmagic Design, Apple, DJI) and implemented in OCIO; names are
  trademarks of their owners, used descriptively.
- False-colour presets "arri-like" and "el-zone" imitate the layout of ARRI's and the EL Zone
  System's false colour; they are not official implementations.
