import type { FrameData, FrameSource, MediaInfo } from './types.js';
import type { ItemSource } from './sequence.js';

/** PNG / JPEG / WebP / AVIF / GIF still images through the browser's decoders (8-bit). */
export class BrowserImageSource implements FrameSource {
  readonly parallelism = 1;
  private constructor(
    readonly info: MediaInfo,
    private readonly bitmap: ImageBitmap,
  ) {}

  static async open(
    src: ItemSource,
    opts: { name: string; signal?: AbortSignal },
  ): Promise<BrowserImageSource> {
    const blob =
      typeof src === 'string' ? await (await fetch(src, { signal: opts.signal })).blob() : src;
    const bitmap = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const info: MediaInfo = {
      kind: 'image',
      name: opts.name,
      width: bitmap.width,
      height: bitmap.height,
      pixelAspectRatio: 1,
      frameCount: 1,
      fps: 24,
      firstFrame: 0,
      duration: 1 / 24,
      hasAlpha: /png|webp|avif|gif/.test(blob.type),
      hasAudio: false,
      codec: blob.type || 'image',
      pixelFormat: 'RGBA 8-bit',
      bitDepth: 8,
      colorHints: { inputSpace: 'srgb', reason: 'browser image (assumed sRGB)' },
      layers: [],
      metadata: { Type: blob.type || 'unknown', Size: `${(blob.size / 1024).toFixed(0)} KB` },
      randomAccess: 'cheap',
    };
    return new BrowserImageSource(info, bitmap);
  }

  async getFrame(index: number): Promise<FrameData> {
    return {
      index,
      bytes: this.bitmap.width * this.bitmap.height * 4,
      decodeMs: 0,
      pixels: {
        kind: 'external',
        width: this.bitmap.width,
        height: this.bitmap.height,
        source: this.bitmap,
        hasAlpha: this.info.hasAlpha,
      },
    };
  }

  dispose(): void {
    this.bitmap.close();
  }
}
