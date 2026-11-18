# Third-party notices

scenelinear is licensed under Apache-2.0. It includes or depends on:

| Component                                                                                                               | Where                                                                           | License                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [OpenEXR](https://github.com/AcademySoftwareFoundation/openexr) 3.4.9 (OpenEXRCore)                                     | compiled into `@scenelinear/exr-wasm`                                           | BSD-3-Clause                                           |
| [Imath](https://github.com/AcademySoftwareFoundation/Imath)                                                             | compiled into `@scenelinear/exr-wasm`                                           | BSD-3-Clause                                           |
| [libdeflate](https://github.com/ebiggers/libdeflate)                                                                    | compiled into `@scenelinear/exr-wasm`                                           | MIT                                                    |
| [OpenJPH](https://github.com/aous72/OpenJPH) 0.26.3 (HTJ2K)                                                             | compiled into `@scenelinear/exr-wasm`                                           | BSD-2-Clause                                           |
| [Emscripten](https://emscripten.org) runtime                                                                            | `@scenelinear/exr-wasm` glue                                                    | MIT / University of Illinois NCSA                      |
| [Mediabunny](https://github.com/Vanilagy/mediabunny)                                                                    | dependency of `@scenelinear/core` (demux, WebCodecs)                            | MPL-2.0                                                |
| [@mediabunny/prores](https://mediabunny.dev/guide/extensions/prores) + [TurboRes](https://github.com/Vanilagy/turbores) | dependency of `@scenelinear/core` (ProRes)                                      | MPL-2.0                                                |
| [Svelte](https://svelte.dev)                                                                                            | `@scenelinear/svelte`, bundled in `@scenelinear/element`                        | MIT                                                    |
| ACES transforms ([aces-aswf](https://github.com/aces-aswf/aces))                                                        | evaluated through OCIO's built-in config to bake `packages/core/src/color/luts` | Academy / ASWF ACES licence (permissive; notices kept) |
| [OpenColorIO](https://opencolorio.org) 2.6                                                                              | build-time only (`tools/ocio-bake`); not shipped                                | BSD-3-Clause                                           |

MPL-2.0 components are used unmodified; MPL is file-level copyleft and does not affect the
licence of scenelinear's own files. If you modify MPL-covered files, those files must stay MPL.

"ACES" and "Academy Color Encoding System" are trademarks of the Academy of Motion Picture Arts and
Sciences. "Apple ProRes" is a trademark of Apple Inc. "OpenEXR" and "OpenColorIO" are projects of
the Academy Software Foundation. This project is not affiliated with or endorsed by any of them.

Full licence texts for the compiled components are written to `packages/exr-wasm/dist-wasm/licenses/`
by the WASM build and included in the published package.
