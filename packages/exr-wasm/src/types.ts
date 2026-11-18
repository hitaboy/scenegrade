// SPDX-License-Identifier: Apache-2.0

export interface Box2 {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export type ExrPixelType = 'half' | 'float' | 'uint';

export interface ExrChannel {
  name: string;
  type: ExrPixelType;
  xSampling: number;
  ySampling: number;
  /** perceptually-linear hint (used by B44 / DWA). */
  pLinear?: boolean;
}

export type ExrChannelMapping = [string | null, string | null, string | null, string | null];

export interface ExrLayer {
  /** '' = default / beauty layer. */
  name: string;
  /** Full channel names belonging to this layer. */
  channels: string[];
  /** Full channel names used for R, G, B, A (null = not present). */
  mapping: ExrChannelMapping;
  /** How the layer is interpreted. */
  kind?: 'rgba' | 'xyz' | 'uv' | 'single' | 'luminance' | 'other';
}

export interface ExrTileInfo {
  xSize: number;
  ySize: number;
  levelMode: 'ONE_LEVEL' | 'MIPMAP_LEVELS' | 'RIPMAP_LEVELS' | 'UNKNOWN';
  roundingMode: 'ROUND_DOWN' | 'ROUND_UP';
  levelsX: number;
  levelsY: number;
}

export type ExrAttributeValue = string | number | number[] | boolean;

export interface ExrChromaticities {
  red: [number, number];
  green: [number, number];
  blue: [number, number];
  white: [number, number];
}

export interface ExrPartInfo {
  index: number;
  name?: string;
  type: 'scanline' | 'tiled' | 'deep';
  /** Raw storage type ('scanline' | 'tiled' | 'deepscanline' | 'deeptile'). */
  storage: string;
  width: number;
  height: number;
  dataWindow: Box2;
  displayWindow: Box2;
  pixelAspectRatio: number;
  compression: string;
  channels: ExrChannel[];
  layers: ExrLayer[];
  chromaticities?: ExrChromaticities;
  tiles?: ExrTileInfo;
  /** All header attributes; exotic types are stringified. */
  attributes: Record<string, ExrAttributeValue>;
  /** OpenEXR type name of every attribute (e.g. 'chromaticities', 'v2f'). */
  attributeTypes: Record<string, string>;
  /** true when this part can be decoded by this package (deep data cannot). */
  supported: boolean;
}

export interface ExrInfo {
  parts: ExrPartInfo[];
}

export interface ExrDecodeOptions {
  /** Part index (default 0). */
  part?: number;
  /** Layer name (default: '' if present, otherwise the first layer). */
  layer?: string;
  /** Output sample format (default 'half'). */
  format?: 'half' | 'float';
  /**
   * Explicit channel mapping for R, G, B, A (full channel names, null = none).
   * Overrides `layer`.
   */
  channels?: ExrChannelMapping;
}

export interface DecodedExr {
  width: number;
  height: number;
  dataWindow: Box2;
  displayWindow: Box2;
  format: 'half' | 'float';
  /** RGBA interleaved, row 0 = top (data window yMin). Half = raw IEEE 754 binary16 bits. */
  pixels: Uint16Array | Float32Array;
  info: ExrPartInfo;
  decodeMs: number;
  /** Layer that was decoded ('' for default, or undefined for an explicit `channels` mapping). */
  layer?: string;
  /** Channel names used for R, G, B, A. */
  mapping: ExrChannelMapping;
  /** Number of chunks that failed to decode (filled with zeros / defaults). 0 for a healthy file. */
  failedChunks: number;
}

export interface ExrDecoder {
  readInfo(bytes: Uint8Array): ExrInfo;
  decode(bytes: Uint8Array, o?: ExrDecodeOptions): DecodedExr;
  dispose(): void;
}

export interface ExrDecoderOptions {
  /** URL of openexr.wasm. Defaults to the copy shipped in this package. */
  wasmUrl?: string | URL;
}

/** Error thrown by the decoder. `code` is the OpenEXRCore error code (or -1). */
export class ExrError extends Error {
  readonly code: number;
  constructor(message: string, code = -1) {
    super(message);
    this.name = 'ExrError';
    this.code = code;
  }
}

/** Thrown for valid files that use features this package does not decode (deep data). */
export class ExrUnsupportedError extends ExrError {
  constructor(message: string, code = -1) {
    super(message, code);
    this.name = 'ExrUnsupportedError';
  }
}
