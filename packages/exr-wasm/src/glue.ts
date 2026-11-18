// SPDX-License-Identifier: Apache-2.0
// Type of the Emscripten module produced by scripts/build-wasm.sh (see src-c/CMakeLists.txt).

export interface OpenEXRModule {
  HEAPU8: Uint8Array;
  UTF8ToString(ptr: number): string;
  stringToUTF8(str: string, ptr: number, maxBytes: number): void;
  lengthBytesUTF8(str: string): number;
  _malloc(n: number): number;
  _free(ptr: number): void;
  _exrw_open(data: number, size: number): number;
  _exrw_close(h: number): void;
  _exrw_header_json(h: number): number;
  _exrw_decode(
    h: number,
    part: number,
    r: number,
    g: number,
    b: number,
    a: number,
    outFloat: number,
  ): number;
  _exrw_result_ptr(h: number): number;
  _exrw_result_size(h: number): number;
  _exrw_result_failed_chunks(h: number): number;
  _exrw_free_result(h: number): void;
  _exrw_last_error(): number;
}

export interface OpenEXRModuleArgs {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}

export type OpenEXRModuleFactory = (args?: OpenEXRModuleArgs) => Promise<OpenEXRModule>;
