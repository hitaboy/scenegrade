/**
 * Media abstractions shared by every source (EXR, image sequences, ProRes, WebCodecs video, still images).
 *
 * A source hands out `FrameData` objects: CPU-side pixel data in one of a few layouts that the GPU
 * renderer knows how to upload and convert to scene-linear ACEScg.
 */

export interface Box2 {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** Half-float RGBA (EXR and other float sources). Row 0 is the top of the data window. */
export interface RgbaHalfFrame {
  kind: 'rgba-half';
  width: number;
  height: number;
  data: Uint16Array;
  /** Data window and display window in pixel coordinates (EXR semantics). */
  dataWindow: Box2;
  displayWindow: Box2;
  hasAlpha: boolean;
}

/** Float32 RGBA, used when the user asks for full precision. */
export interface RgbaFloatFrame {
  kind: 'rgba-float';
  width: number;
  height: number;
  data: Float32Array;
  dataWindow: Box2;
  displayWindow: Box2;
  hasAlpha: boolean;
}

export type ChromaSubsampling = '420' | '422' | '444';
export type YuvMatrix = 'bt709' | 'bt2020' | 'bt601' | 'rgb';

/** Planar Y'CbCr straight from a decoder (ProRes via TurboRes, WebCodecs `copyTo`). */
export interface YuvFrame {
  kind: 'yuv';
  width: number;
  height: number;
  bitDepth: 8 | 10 | 12;
  chroma: ChromaSubsampling;
  /** Y, Cb, Cr and optionally A. 8-bit planes are 1 byte per sample, deeper planes are 16-bit LE. */
  planes: { data: Uint8Array; stride: number }[];
  hasAlpha: boolean;
  matrix: YuvMatrix;
  fullRange: boolean;
}

/** Packed 8-bit RGBA (PNG/JPEG/WebP, or WebCodecs frames converted to RGBA). */
export interface Rgba8Frame {
  kind: 'rgba8';
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  hasAlpha: boolean;
}

/** Browser-owned frame. Fallback path when the decoder output cannot be read back (opaque hardware frames). */
export interface ExternalFrame {
  kind: 'external';
  width: number;
  height: number;
  source: VideoFrame | ImageBitmap;
  hasAlpha: boolean;
}

export type FramePixels = RgbaHalfFrame | RgbaFloatFrame | YuvFrame | Rgba8Frame | ExternalFrame;

export interface FrameData {
  /** Zero-based frame index inside the source. */
  index: number;
  pixels: FramePixels;
  /** Approximate size in bytes, used by the frame cache budget. */
  bytes: number;
  /** Decode time in ms (for stats). */
  decodeMs: number;
  /** Release browser-owned resources (VideoFrame, ImageBitmap). */
  release?: () => void;
}

export type MediaKind = 'image' | 'sequence' | 'video';

export interface ColorHints {
  /** Best guess of the input colour space id (see color/INPUT_SPACES); may be undefined. */
  inputSpace?: string;
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
  /** Why we guessed `inputSpace`, shown in the UI. */
  reason?: string;
}

export interface LayerInfo {
  /** '' = default (beauty). */
  name: string;
  channels: string[];
  part?: number;
}

export interface MediaInfo {
  kind: MediaKind;
  name: string;
  width: number;
  height: number;
  pixelAspectRatio: number;
  frameCount: number;
  fps: number;
  /** First frame number shown to the user (e.g. 1001 for sequences). */
  firstFrame: number;
  /** Start timecode as frames from 00:00:00:00, if the container carries one. */
  startTimecodeFrames?: number;
  duration: number;
  hasAlpha: boolean;
  hasAudio: boolean;
  codec?: string;
  pixelFormat?: string;
  bitDepth?: number;
  colorHints: ColorHints;
  layers: LayerInfo[];
  /** Flat, human-readable metadata for the info panel. */
  metadata: Record<string, string>;
  /** Random access is cheap (EXR, ProRes, all-intra) vs. needs sequential decoding (long-GOP). */
  randomAccess: 'cheap' | 'sequential';
}

export interface FrameRequest {
  signal?: AbortSignal;
  /** Higher = more urgent. The frame on screen uses Infinity. */
  priority?: number;
  layer?: string;
}

export interface FrameSource {
  readonly info: MediaInfo;
  getFrame(index: number, req?: FrameRequest): Promise<FrameData>;
  /** How many frames the source can usefully decode in parallel. */
  readonly parallelism: number;
  /** Optional: audio for the player clock. */
  readonly audio?: AudioSource;
  dispose(): void;
}

export interface AudioSource {
  sampleRate: number;
  channels: number;
  /** Async iterator of decoded buffers starting at `time` seconds (media time). */
  buffers(
    time: number,
  ): AsyncGenerator<{ buffer: AudioBuffer; timestamp: number; duration: number }>;
}

export function frameBytes(p: FramePixels): number {
  switch (p.kind) {
    case 'rgba-half':
    case 'rgba-float':
    case 'rgba8':
      return p.data.byteLength;
    case 'yuv':
      return p.planes.reduce((n, pl) => n + pl.data.byteLength, 0);
    case 'external':
      return p.width * p.height * 4;
  }
}
