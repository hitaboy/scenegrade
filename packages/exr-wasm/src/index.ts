// SPDX-License-Identifier: Apache-2.0
//
// @scenelinear/exr-wasm — OpenEXR (OpenEXRCore) decoding in WebAssembly.

export type {
  Box2,
  DecodedExr,
  ExrAttributeValue,
  ExrChannel,
  ExrChannelMapping,
  ExrChromaticities,
  ExrDecodeOptions,
  ExrDecoder,
  ExrDecoderOptions,
  ExrInfo,
  ExrLayer,
  ExrPartInfo,
  ExrPixelType,
  ExrTileInfo,
} from './types.ts';
export { ExrError, ExrUnsupportedError } from './types.ts';
export { createExrDecoder, defaultWasmUrl } from './decoder.ts';
export { ExrWorkerPool, type ExrPoolDecodeOptions, type ExrWorkerPoolOptions } from './pool.ts';
export { groupLayers, defaultLayer } from './layers.ts';
export { halfToFloat, halfArrayToFloat32 } from './half.ts';
