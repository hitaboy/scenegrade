// SPDX-License-Identifier: Apache-2.0
//
// Synchronous OpenEXR decoder on top of the Emscripten module (dist-wasm/openexr.{mjs,wasm}).
// Usable on the main thread, in a worker, and in Node (tests).

import { defaultLayer, groupLayers } from './layers.ts';
import {
  ExrError,
  ExrUnsupportedError,
  type Box2,
  type DecodedExr,
  type ExrAttributeValue,
  type ExrChannel,
  type ExrChannelMapping,
  type ExrDecodeOptions,
  type ExrDecoder,
  type ExrDecoderOptions,
  type ExrInfo,
  type ExrPartInfo,
  type ExrTileInfo,
} from './types.ts';
import type { OpenEXRModule, OpenEXRModuleFactory } from './glue.ts';

/** Default location of the wasm binary shipped with this package. */
export function defaultWasmUrl(): string {
  return new URL('../dist-wasm/openexr.wasm', import.meta.url).href;
}

function isNode(): boolean {
  const p = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return !!p?.versions?.node && typeof (globalThis as { window?: unknown }).window === 'undefined';
}

async function readFileInNode(url: string): Promise<Uint8Array> {
  // Indirect specifiers keep bundlers from trying to resolve Node built-ins for the browser.
  const fsName = 'node:fs/promises';
  const urlName = 'node:url';
  const fs = (await import(/* @vite-ignore */ fsName)) as {
    readFile(path: string): Promise<Uint8Array>;
  };
  const { fileURLToPath } = (await import(/* @vite-ignore */ urlName)) as {
    fileURLToPath(url: string): string;
  };
  return new Uint8Array(await fs.readFile(url.startsWith('file:') ? fileURLToPath(url) : url));
}

async function loadModule(wasmUrl: string): Promise<OpenEXRModule> {
  const factory = (await import('../dist-wasm/openexr.mjs')).default as OpenEXRModuleFactory;
  if (isNode() && (wasmUrl.startsWith('file:') || !/^[a-z]+:/i.test(wasmUrl))) {
    const wasmBinary = await readFileInNode(wasmUrl);
    return factory({ wasmBinary });
  }
  return factory({
    locateFile: (path: string, prefix: string) =>
      path.endsWith('.wasm') ? wasmUrl : prefix + path,
  });
}

// ------------------------------------------------------------------------- header JSON

interface RawPart {
  index: number;
  name?: string;
  type: 'scanline' | 'tiled' | 'deep';
  storage: string;
  width: number;
  height: number;
  dataWindow: Box2;
  displayWindow: Box2;
  pixelAspectRatio: number | null;
  compression: string;
  tiles?: ExrTileInfo;
  channels: (ExrChannel & { pLinear: boolean })[];
  attributes: Record<string, ExrAttributeValue | null>;
  attributeTypes: Record<string, string>;
}

function toPartInfo(raw: RawPart): ExrPartInfo {
  const attributes: Record<string, ExrAttributeValue> = {};
  for (const [k, v] of Object.entries(raw.attributes)) attributes[k] = v === null ? NaN : v;
  const part: ExrPartInfo = {
    index: raw.index,
    type: raw.type,
    storage: raw.storage,
    width: raw.width,
    height: raw.height,
    dataWindow: raw.dataWindow,
    displayWindow: raw.displayWindow,
    pixelAspectRatio: raw.pixelAspectRatio ?? 1,
    compression: raw.compression,
    channels: raw.channels,
    layers: groupLayers(raw.channels.map((c) => c.name)),
    attributes,
    attributeTypes: raw.attributeTypes,
    supported: raw.type !== 'deep',
  };
  if (raw.name !== undefined) part.name = raw.name;
  if (raw.tiles) part.tiles = raw.tiles;
  const chr = raw.attributes.chromaticities;
  if (Array.isArray(chr) && chr.length === 8) {
    part.chromaticities = {
      red: [chr[0], chr[1]],
      green: [chr[2], chr[3]],
      blue: [chr[4], chr[5]],
      white: [chr[6], chr[7]],
    };
  }
  return part;
}

// ------------------------------------------------------------------------- decoder

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** OpenEXRCore EXR_ERR_FEATURE_NOT_IMPLEMENTED */
const EXR_ERR_FEATURE_NOT_IMPLEMENTED = 19;

export function resolveMapping(
  info: ExrPartInfo,
  o: ExrDecodeOptions,
): { mapping: ExrChannelMapping; layer?: string } {
  if (o.channels) {
    const names = new Set(info.channels.map((c) => c.name));
    for (const c of o.channels)
      if (c !== null && !names.has(c))
        throw new ExrError(`channel '${c}' not found in part ${info.index}`);
    return { mapping: [...o.channels] as ExrChannelMapping };
  }
  const layer =
    o.layer !== undefined ? info.layers.find((l) => l.name === o.layer) : defaultLayer(info.layers);
  if (!layer) {
    if (o.layer !== undefined)
      throw new ExrError(
        `layer '${o.layer}' not found in part ${info.index} (available: ${info.layers.map((l) => `'${l.name}'`).join(', ')})`,
      );
    return { mapping: [null, null, null, null], layer: '' };
  }
  return { mapping: [...layer.mapping] as ExrChannelMapping, layer: layer.name };
}

class Decoder implements ExrDecoder {
  #m: OpenEXRModule | null;

  constructor(m: OpenEXRModule) {
    this.#m = m;
  }

  get #mod(): OpenEXRModule {
    if (!this.#m) throw new ExrError('decoder has been disposed');
    return this.#m;
  }

  #lastError(): string {
    const m = this.#mod;
    return m.UTF8ToString(m._exrw_last_error()) || 'unknown error';
  }

  /** Copies the file into wasm memory and opens it; `fn` runs with the handle. */
  #withFile<T>(bytes: Uint8Array, fn: (h: number, infos: ExrPartInfo[]) => T): T {
    const m = this.#mod;
    if (!(bytes instanceof Uint8Array)) throw new ExrError('expected a Uint8Array');
    if (bytes.length < 8) throw new ExrError('not an OpenEXR file (too short)');
    const ptr = m._malloc(bytes.length);
    if (!ptr) throw new ExrError(`out of memory (file of ${bytes.length} bytes)`);
    let h = 0;
    try {
      m.HEAPU8.set(bytes, ptr);
      h = m._exrw_open(ptr, bytes.length);
      if (!h) throw new ExrError(`cannot open EXR: ${this.#lastError()}`);
      const jsonPtr = m._exrw_header_json(h);
      if (!jsonPtr) throw new ExrError(`cannot read EXR header: ${this.#lastError()}`);
      const raw = JSON.parse(m.UTF8ToString(jsonPtr)) as { parts: RawPart[] };
      return fn(h, raw.parts.map(toPartInfo));
    } finally {
      if (h) m._exrw_close(h);
      m._free(ptr);
    }
  }

  readInfo(bytes: Uint8Array): ExrInfo {
    return this.#withFile(bytes, (_h, parts) => ({ parts }));
  }

  decode(bytes: Uint8Array, o: ExrDecodeOptions = {}): DecodedExr {
    const t0 = now();
    const format = o.format ?? 'half';
    const partIndex = o.part ?? 0;
    return this.#withFile(bytes, (h, parts) => {
      const m = this.#mod;
      const info = parts[partIndex];
      if (!info)
        throw new ExrError(`part ${partIndex} out of range (file has ${parts.length} parts)`);
      if (info.type === 'deep')
        throw new ExrUnsupportedError(
          `part ${partIndex} contains deep data, which is not supported`,
          EXR_ERR_FEATURE_NOT_IMPLEMENTED,
        );
      const { mapping, layer } = resolveMapping(info, o);

      // channel names -> wasm strings
      const strPtrs = mapping.map((name) => {
        if (!name) return 0;
        const n = m.lengthBytesUTF8(name) + 1;
        const p = m._malloc(n);
        m.stringToUTF8(name, p, n);
        return p;
      });
      try {
        const rc = m._exrw_decode(
          h,
          partIndex,
          strPtrs[0],
          strPtrs[1],
          strPtrs[2],
          strPtrs[3],
          format === 'float' ? 1 : 0,
        );
        if (rc !== 0) {
          const msg = this.#lastError();
          if (rc === EXR_ERR_FEATURE_NOT_IMPLEMENTED) throw new ExrUnsupportedError(msg, rc);
          throw new ExrError(`decode failed: ${msg}`, rc);
        }
        const rp = m._exrw_result_ptr(h);
        const size = m._exrw_result_size(h);
        // single copy out of the wasm heap; the resulting buffer is transferable
        const copy = m.HEAPU8.slice(rp, rp + size);
        m._exrw_free_result(h);
        const pixels =
          format === 'float' ? new Float32Array(copy.buffer) : new Uint16Array(copy.buffer);
        const result: DecodedExr = {
          width: info.width,
          height: info.height,
          dataWindow: info.dataWindow,
          displayWindow: info.displayWindow,
          format,
          pixels,
          info,
          decodeMs: now() - t0,
          mapping,
          failedChunks: m._exrw_result_failed_chunks(h),
        };
        if (layer !== undefined) result.layer = layer;
        return result;
      } finally {
        for (const p of strPtrs) if (p) m._free(p);
      }
    });
  }

  dispose(): void {
    this.#m = null;
  }
}

/** Instantiate the wasm module and return a synchronous decoder. */
export async function createExrDecoder(opts: ExrDecoderOptions = {}): Promise<ExrDecoder> {
  const url = opts.wasmUrl !== undefined ? String(opts.wasmUrl) : defaultWasmUrl();
  const m = await loadModule(url);
  return new Decoder(m);
}
