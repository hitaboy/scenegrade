import { ExrWorkerPool, type ExrInfo, type ExrPartInfo } from '@scenelinear/exr-wasm';
import type {
  ColorHints,
  FrameData,
  FrameRequest,
  FrameSource,
  LayerInfo,
  MediaInfo,
} from './types.js';
import { readBytes, type SequenceItem } from './sequence.js';

let sharedPool: ExrWorkerPool | null = null;
let poolOpts: { size?: number; wasmUrl?: string } = {};

/** Configure the shared EXR worker pool before the first EXR is opened. */
export function configureExrPool(opts: { size?: number; wasmUrl?: string }): void {
  poolOpts = opts;
  if (sharedPool) {
    sharedPool.dispose();
    sharedPool = null;
  }
}

export function getExrPool(): ExrWorkerPool {
  if (!sharedPool) sharedPool = new ExrWorkerPool(poolOpts);
  return sharedPool;
}

const near = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) < 2e-3 && Math.abs(a[1] - b[1]) < 2e-3;

/** Guess the colour space from the EXR header (chromaticities / ACES container flag). */
export function exrColorHints(part: ExrPartInfo, fallback: string): ColorHints {
  const c = part.chromaticities;
  const aces = part.attributes['acesImageContainerFlag'];
  if (aces === 1 || aces === '1')
    return { inputSpace: 'aces2065-1', reason: 'acesImageContainerFlag' };
  if (c) {
    if (near(c.red, [0.7347, 0.2653]) && near(c.green, [0, 1]))
      return { inputSpace: 'aces2065-1', reason: 'chromaticities = AP0' };
    if (near(c.red, [0.713, 0.293]) && near(c.green, [0.165, 0.83]))
      return { inputSpace: 'acescg', reason: 'chromaticities = AP1' };
    if (near(c.red, [0.64, 0.33]) && near(c.green, [0.3, 0.6]))
      return { inputSpace: 'lin-rec709', reason: 'chromaticities = Rec.709' };
    if (near(c.red, [0.68, 0.32]) && near(c.green, [0.265, 0.69]))
      return { inputSpace: 'lin-p3d65', reason: 'chromaticities = P3-D65' };
    if (near(c.red, [0.708, 0.292]) && near(c.green, [0.17, 0.797]))
      return { inputSpace: 'lin-rec2020', reason: 'chromaticities = Rec.2020' };
    return { inputSpace: fallback, reason: 'unrecognised chromaticities' };
  }
  return { inputSpace: fallback, reason: 'no chromaticities attribute' };
}

function layersOf(info: ExrInfo): LayerInfo[] {
  const out: LayerInfo[] = [];
  for (const p of info.parts) {
    if (p.type === 'deep') continue;
    for (const l of p.layers) {
      out.push({
        name: info.parts.length > 1 ? `${p.name ?? `part${p.index}`}/${l.name}` : l.name,
        channels: l.channels,
        part: p.index,
      });
    }
  }
  return out;
}

function flatAttrs(p: ExrPartInfo): Record<string, string> {
  const m: Record<string, string> = {
    Compression: p.compression,
    Storage: p.type,
    'Data window': `${p.dataWindow.xMin},${p.dataWindow.yMin} – ${p.dataWindow.xMax},${p.dataWindow.yMax}`,
    'Display window': `${p.displayWindow.xMin},${p.displayWindow.yMin} – ${p.displayWindow.xMax},${p.displayWindow.yMax}`,
    Channels: p.channels.map((c) => `${c.name} (${c.type})`).join(', '),
  };
  if (p.chromaticities) {
    const c = p.chromaticities;
    m.Chromaticities = `R ${c.red.join(',')}  G ${c.green.join(',')}  B ${c.blue.join(',')}  W ${c.white.join(',')}`;
  }
  for (const [k, v] of Object.entries(p.attributes)) {
    if (
      k in m ||
      ['channels', 'compression', 'dataWindow', 'displayWindow', 'chromaticities'].includes(k)
    )
      continue;
    m[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return m;
}

/** A single EXR or an EXR frame sequence. */
export class ExrSource implements FrameSource {
  readonly parallelism: number;
  private constructor(
    readonly info: MediaInfo,
    private readonly items: SequenceItem[],
    private readonly pool: ExrWorkerPool,
    private readonly exrInfo: ExrInfo,
  ) {
    this.parallelism = Math.max(
      2,
      (pool as unknown as { size?: number }).size ??
        Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 4) - 2),
    );
  }

  static async open(
    items: SequenceItem[],
    opts: { name: string; fps?: number; defaultSpace?: string; signal?: AbortSignal },
  ): Promise<ExrSource> {
    if (items.length === 0) throw new Error('Empty EXR sequence');
    const pool = getExrPool();
    const bytes = await readBytes(items[0].src, opts.signal);
    const exrInfo = await pool.readInfo(bytes);
    const part = exrInfo.parts.find((p) => p.type !== 'deep');
    if (!part) throw new Error('Deep EXR images are not supported');
    const fpsAttr = part.attributes['framesPerSecond'];
    let fps = opts.fps ?? 24;
    if (!opts.fps && typeof fpsAttr === 'string' && /\d+\/\d+/.test(fpsAttr)) {
      const [n, d] = fpsAttr.split('/').map(Number);
      if (n > 0 && d > 0) fps = n / d;
    } else if (!opts.fps && Array.isArray(fpsAttr) && fpsAttr.length === 2) {
      fps = fpsAttr[0] / fpsAttr[1];
    }
    const disp = part.displayWindow;
    const hasAlpha = part.layers.some((l) => l.name === '' && l.mapping[3] != null);
    const info: MediaInfo = {
      kind: items.length > 1 ? 'sequence' : 'image',
      name: opts.name,
      width: disp.xMax - disp.xMin + 1,
      height: disp.yMax - disp.yMin + 1,
      pixelAspectRatio: part.pixelAspectRatio || 1,
      frameCount: items.length,
      fps,
      firstFrame: items[0].frame,
      duration: items.length / fps,
      hasAlpha,
      hasAudio: false,
      codec: `OpenEXR ${part.compression}`,
      pixelFormat: part.channels.map((c) => c.type).includes('float') ? 'float' : 'half',
      colorHints: exrColorHints(part, opts.defaultSpace ?? 'acescg'),
      layers: layersOf(exrInfo),
      metadata: flatAttrs(part),
      randomAccess: 'cheap',
    };
    return new ExrSource(info, items, pool, exrInfo);
  }

  async getFrame(index: number, req: FrameRequest = {}): Promise<FrameData> {
    const item = this.items[Math.max(0, Math.min(this.items.length - 1, index))];
    let part = 0;
    let layer = req.layer ?? '';
    if (this.exrInfo.parts.length > 1) {
      const l = this.info.layers.find((x) => x.name === layer) ?? this.info.layers[0];
      part = l?.part ?? 0;
      layer = l ? l.name.slice(l.name.indexOf('/') + 1) : '';
    }
    const src = typeof item.src === 'string' ? item.src : await readBytes(item.src, req.signal);
    const t0 = performance.now();
    const img = await this.pool.decode(src, {
      part,
      layer,
      format: 'half',
      signal: req.signal,
      priority: req.priority,
    });
    const pixels = img.pixels as Uint16Array;
    return {
      index,
      bytes: pixels.byteLength,
      decodeMs: img.decodeMs ?? performance.now() - t0,
      pixels: {
        kind: 'rgba-half',
        width: img.width,
        height: img.height,
        data: pixels,
        dataWindow: img.dataWindow,
        displayWindow: img.displayWindow,
        hasAlpha: img.info.layers.find((l) => l.name === layer)?.mapping[3] != null,
      },
    };
  }

  dispose(): void {
    /* the pool is shared */
  }
}
