# Contributing

Thanks for helping! Bug reports with a sample file (or how to generate one) are the most useful
thing you can send.

## Setup

Requirements: Node ≥ 20.19, pnpm 9, Docker (for the OpenEXR WASM build), [uv](https://docs.astral.sh/uv/)
and ffmpeg (for test media and the OCIO bake).

```sh
pnpm install
packages/exr-wasm/scripts/build-wasm.sh   # once; CLEAN=1 to rebuild from scratch
pnpm media                                # generated test media (not committed)
pnpm dev                                  # demo at http://localhost:5199
```

## Checks before a PR

```sh
pnpm check     # tsc + svelte-check
pnpm test      # vitest: colour vs OCIO fixtures, EXR decoder, player utilities
pnpm e2e       # Playwright + real WebGPU (Chrome)
pnpm format
```

Add a changeset for user-visible changes: `pnpm changeset`.

## Ground rules

- **Colour changes need numbers.** If you touch `packages/core/src/color` or the shaders, run the
  bake (`pnpm bake:luts --eval-only`) and/or the tests and paste the ΔE before/after.
- **No binaries by hand.** The WASM and the LUTs are produced by scripts (`build-wasm.sh`,
  `tools/ocio-bake/bake.py`). LUTs are committed because they are deterministic and small; the
  WASM is built in CI.
- **No client material.** Test media must be synthetic or openly licensed.
- **Keep the UI neutral grey** (see [docs/design.md](docs/design.md)).
- Code, comments and docs in English.

## Project layout

See [docs/architecture.md](docs/architecture.md).
