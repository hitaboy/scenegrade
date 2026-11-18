// SPDX-License-Identifier: Apache-2.0
// Ambient declaration for the Emscripten ES module factory in dist-wasm/
// (the real signature is OpenEXRModuleFactory in glue.ts).

declare module '*/dist-wasm/openexr.mjs' {
  const factory: (args?: object) => Promise<unknown>;
  export default factory;
}
