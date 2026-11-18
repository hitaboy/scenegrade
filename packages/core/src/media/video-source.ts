import {
  Input,
  ALL_FORMATS,
  BlobSource,
  UrlSource,
  VideoSampleSink,
  AudioBufferSink,
  type InputVideoTrack,
  type VideoSample,
} from 'mediabunny';
import type {
  AudioSource,
  ColorHints,
  FrameData,
  FramePixels,
  FrameRequest,
  FrameSource,
  MediaInfo,
  YuvMatrix,
} from './types.js';

let proresRegistered: Promise<void> | null = null;

/** Registers the TurboRes ProRes decoder with Mediabunny (once, lazily: the WASM is only fetched for ProRes). */
export function ensureProres(): Promise<void> {
  if (!proresRegistered) {
    proresRegistered = import('@mediabunny/prores').then((m) => m.registerProresDecoder());
  }
  return proresRegistered;
}

const MATRIX: Record<string, YuvMatrix> = {
  bt709: 'bt709',
  'bt2020-ncl': 'bt2020',
  bt2020: 'bt2020',
  smpte170m: 'bt601',
  bt470bg: 'bt601',
  rgb: 'rgb',
};

export function videoColorHints(cs: {
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
}): ColorHints {
  const base = {
    primaries: cs.primaries ?? null,
    transfer: cs.transfer ?? null,
    matrix: cs.matrix ?? null,
    fullRange: cs.fullRange ?? null,
  };
  switch (cs.transfer) {
    case 'iec61966-2-1':
      return {
        ...base,
        inputSpace: cs.primaries === 'smpte432' ? 'display-p3' : 'srgb',
        reason: 'transfer = sRGB',
      };
    case 'linear':
      return {
        ...base,
        inputSpace: cs.primaries === 'bt2020' ? 'lin-rec2020' : 'lin-rec709',
        reason: 'transfer = linear',
      };
    case 'bt709':
    case 'smpte170m':
      return {
        ...base,
        inputSpace: 'rec709',
        reason:
          'tagged BT.709 — camera log footage is often mis-tagged as 709; pick the log space if needed',
      };
    default:
      return {
        ...base,
        inputSpace: 'rec709',
        reason: cs.transfer ? `transfer ${cs.transfer} (no exact match)` : 'untagged',
      };
  }
}

/**
 * Converts a decoded VideoSample into CPU pixels we can upload with full bit depth.
 * Planar YUV (ProRes, software decoders) is copied as-is. Opaque hardware frames are converted to RGBA.
 */
async function samplePixels(s: VideoSample): Promise<{ pixels: FramePixels; bytes: number }> {
  const w = s.codedWidth;
  const h = s.codedHeight;
  const fmt = s.format;
  const cs = s.colorSpace;
  const matrix = MATRIX[cs.matrix ?? ''] ?? 'bt709';
  const fullRange = cs.fullRange ?? false;

  const m = fmt ? /^I(420|422|444)(A?)(?:P(10|12))?$/.exec(fmt) : null;
  if (m) {
    const size = s.allocationSize();
    const buf = new Uint8Array(size);
    const layout = await s.copyTo(buf);
    const bitDepth = (m[3] ? parseInt(m[3], 10) : 8) as 8 | 10 | 12;
    const chroma = m[1] as '420' | '422' | '444';
    const bpp = bitDepth > 8 ? 2 : 1;
    const cw = chroma === '444' ? w : Math.ceil(w / 2);
    const ch = chroma === '420' ? Math.ceil(h / 2) : h;
    const heights = [h, ch, ch, h];
    const planes = layout.map((l, i) => ({
      data: buf.subarray(l.offset, l.offset + l.stride * heights[i]),
      stride: l.stride,
    }));
    void cw;
    void bpp;
    return {
      pixels: {
        kind: 'yuv',
        width: w,
        height: h,
        bitDepth,
        chroma,
        planes,
        hasAlpha: m[2] === 'A',
        matrix,
        fullRange,
      },
      bytes: size,
    };
  }
  if (fmt === 'NV12') {
    const size = s.allocationSize();
    const buf = new Uint8Array(size);
    const layout = await s.copyTo(buf);
    const cw = Math.ceil(w / 2),
      ch = Math.ceil(h / 2);
    const u = new Uint8Array(cw * ch),
      v = new Uint8Array(cw * ch);
    const uv = layout[1];
    for (let y = 0; y < ch; y++) {
      const row = uv.offset + y * uv.stride;
      for (let x = 0; x < cw; x++) {
        u[y * cw + x] = buf[row + 2 * x];
        v[y * cw + x] = buf[row + 2 * x + 1];
      }
    }
    const yl = layout[0];
    return {
      pixels: {
        kind: 'yuv',
        width: w,
        height: h,
        bitDepth: 8,
        chroma: '420',
        planes: [
          { data: buf.subarray(yl.offset, yl.offset + yl.stride * h), stride: yl.stride },
          { data: u, stride: cw },
          { data: v, stride: cw },
        ],
        hasAlpha: false,
        matrix,
        fullRange,
      },
      bytes: size,
    };
  }
  if (fmt === 'RGBA' || fmt === 'RGBX' || fmt === 'BGRA' || fmt === 'BGRX') {
    const buf = new Uint8Array(w * h * 4);
    await s.copyTo(buf, { layout: [{ offset: 0, stride: w * 4 }] } as VideoFrameCopyToOptions);
    if (fmt.startsWith('B'))
      for (let i = 0; i < buf.length; i += 4) [buf[i], buf[i + 2]] = [buf[i + 2], buf[i]];
    return {
      pixels: { kind: 'rgba8', width: w, height: h, data: buf, hasAlpha: fmt.endsWith('A') },
      bytes: buf.byteLength,
    };
  }
  // Opaque (hardware) frame: ask the browser for RGBA (8-bit); fall back to an external texture.
  const frame = s.toVideoFrame();
  try {
    const buf = new Uint8Array(w * h * 4);
    await frame.copyTo(buf, { format: 'RGBA', colorSpace: 'srgb' } as VideoFrameCopyToOptions);
    frame.close();
    return {
      pixels: { kind: 'rgba8', width: w, height: h, data: buf, hasAlpha: false },
      bytes: buf.byteLength,
    };
  } catch {
    return {
      pixels: { kind: 'external', width: w, height: h, source: frame, hasAlpha: false },
      bytes: w * h * 4,
    };
  }
}

interface Pending {
  resolve: (f: FrameData) => void;
  reject: (e: unknown) => void;
  priority: number;
}

interface Cursor {
  iter: AsyncGenerator<VideoSample, void, unknown>;
  /** Index of the next frame this iterator will produce. */
  next: number;
  lastUsed: number;
}

/**
 * Video file source (MOV/MP4/MKV/WebM) backed by Mediabunny. ProRes goes through TurboRes (WASM),
 * everything else through WebCodecs.
 *
 * Decoding is driven by sequential iterators (cursors): a request is served by the cursor just
 * behind it; otherwise the least recently used cursor seeks. Two cursors let playback loop
 * (one keeps decoding the end of the range while the other pre-decodes the start). Frames decoded on
 * the way are kept in a small look-ahead map so nothing is decoded twice.
 */
export class VideoSource implements FrameSource {
  readonly parallelism = 2;
  readonly audio?: AudioSource;
  private cursors: (Cursor | null)[] = [null, null];
  private pumping = false;
  private pending = new Map<number, Pending[]>();
  private lookahead = new Map<number, FrameData>();
  private closed = false;
  private tick = 0;

  private constructor(
    readonly info: MediaInfo,
    private readonly input: Input,
    private readonly track: InputVideoTrack,
    private readonly sink: VideoSampleSink,
    private readonly firstTs: number,
    audio: AudioSource | undefined,
  ) {
    this.audio = audio;
    void this.track;
  }

  static async open(
    src: File | Blob | string,
    opts: { name: string; signal?: AbortSignal },
  ): Promise<VideoSource> {
    const source = typeof src === 'string' ? new UrlSource(src) : new BlobSource(src);
    const input = new Input({ formats: ALL_FORMATS, source });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track found');
    const codec = await track.getCodec();
    if (codec === 'prores') await ensureProres();
    if (!(await track.canDecode())) {
      throw new Error(
        `This browser cannot decode ${codec ?? 'this'} video${codec === 'hevc' ? ' (HEVC needs hardware support)' : ''}`,
      );
    }
    const stats = await track.computePacketStats(120);
    const fps = stats.averagePacketRate > 0 ? stats.averagePacketRate : 24;
    const firstTs = await track.getFirstTimestamp();
    const duration = await input.computeDuration([track]);
    const frameCount = Math.max(1, Math.round((duration - firstTs) * fps));
    const cs = await track.getColorSpace();
    let sink = new VideoSampleSink(track);

    // Probe the first frame for pixel format / alpha.
    let first = await sink.getSample(firstTs);
    // Hardware decoders often return opaque frames we can only read back as 8-bit RGBA. For codecs
    // with a software decoder in the browser (AV1 / VP9), prefer it to keep 10/12-bit planar data.
    if (first && !first.format && (codec === 'av1' || codec === 'vp9')) {
      const soft = new VideoSampleSink(track, { hardwareAcceleration: 'prefer-software' });
      const s2 = await soft.getSample(firstTs).catch(() => null);
      if (s2?.format) {
        first.close();
        first = s2;
        sink = soft;
      } else s2?.close();
    }
    const pixelFormat = first?.format ?? 'opaque';
    const hasAlpha =
      !!first?.hasAlpha || /A/.test(pixelFormat.replace(/^I\d+/, '').replace(/P\d+$/, ''));
    const bitDepth = /P12/.test(pixelFormat) ? 12 : /P10/.test(pixelFormat) ? 10 : 8;
    first?.close();

    const meta: Record<string, string> = {
      Container: (await input.getFormat()).name,
      Codec: (await track.getCodecParameterString()) ?? codec ?? 'unknown',
      'Pixel format': pixelFormat,
      Resolution: `${track.codedWidth} × ${track.codedHeight}`,
      'Frame rate': fps.toFixed(3),
      Bitrate: `${(stats.averageBitrate / 1e6).toFixed(1)} Mb/s`,
      Primaries: String(cs.primaries ?? '—'),
      Transfer: String(cs.transfer ?? '—'),
      Matrix: String(cs.matrix ?? '—'),
      Range: cs.fullRange == null ? '—' : cs.fullRange ? 'full' : 'limited',
    };
    try {
      const tags = await input.getMetadataTags();
      for (const [k, v] of Object.entries(tags))
        if (typeof v === 'string' || typeof v === 'number') meta[k] = String(v);
    } catch {
      /* optional */
    }

    let audio: AudioSource | undefined;
    const at = await input.getPrimaryAudioTrack();
    if (at && (await at.canDecode())) {
      const asink = new AudioBufferSink(at);
      audio = {
        sampleRate: at.sampleRate,
        channels: at.numberOfChannels,
        buffers: (t: number) =>
          asink.buffers(t) as AsyncGenerator<{
            buffer: AudioBuffer;
            timestamp: number;
            duration: number;
          }>,
      };
      meta.Audio = `${at.codec ?? '?'} ${at.numberOfChannels}ch ${at.sampleRate} Hz`;
    }

    const allIntra = codec === 'prores' || (await track.hasOnlyKeyPackets());
    const info: MediaInfo = {
      kind: 'video',
      name: opts.name,
      width: track.displayWidth,
      height: track.displayHeight,
      pixelAspectRatio: track.pixelAspectRatio.num / track.pixelAspectRatio.den || 1,
      frameCount,
      fps,
      firstFrame: 0,
      duration: duration - firstTs,
      hasAlpha,
      hasAudio: !!audio,
      codec: codec ?? undefined,
      pixelFormat,
      bitDepth,
      colorHints: videoColorHints(cs),
      layers: [],
      metadata: meta,
      randomAccess: allIntra ? 'cheap' : 'sequential',
    };
    return new VideoSource(info, input, track, sink, firstTs, audio);
  }

  private tsOf(index: number): number {
    return this.firstTs + (index + 0.5) / this.info.fps;
  }

  private indexOf(ts: number): number {
    return Math.round((ts - this.firstTs) * this.info.fps);
  }

  getFrame(index: number, req: FrameRequest = {}): Promise<FrameData> {
    index = Math.max(0, Math.min(this.info.frameCount - 1, index));
    const ready = this.lookahead.get(index);
    if (ready) {
      this.lookahead.delete(index);
      return Promise.resolve(ready);
    }
    return new Promise<FrameData>((resolve, reject) => {
      const list = this.pending.get(index) ?? [];
      list.push({ resolve, reject, priority: req.priority ?? 0 });
      this.pending.set(index, list);
      req.signal?.addEventListener('abort', () => {
        const l = this.pending.get(index);
        if (!l) return;
        const i = l.findIndex((p) => p.resolve === resolve);
        if (i >= 0) l.splice(i, 1);
        if (l.length === 0) this.pending.delete(index);
        reject(new DOMException('Aborted', 'AbortError'));
      });
      void this.pump();
    });
  }

  /** Maximum distance a cursor may decode forward to reach a request instead of seeking. */
  private get window(): number {
    return this.info.randomAccess === 'cheap' ? 6 : 120;
  }

  /** Picks (or creates by seeking) the cursor that should serve frame `index`. */
  private cursorFor(index: number): Cursor {
    let best: Cursor | null = null;
    for (const c of this.cursors) {
      if (c && c.next <= index && index - c.next <= this.window && (!best || c.next > best.next))
        best = c;
    }
    if (best) return best;
    // Seek: replace the least recently used cursor.
    let slot = this.cursors.findIndex((c) => !c);
    if (slot < 0) slot = this.cursors[0]!.lastUsed <= this.cursors[1]!.lastUsed ? 0 : 1;
    const old = this.cursors[slot];
    if (old) void old.iter.return(undefined);
    const c: Cursor = {
      iter: this.sink.samples(this.tsOf(index) - 0.5 / this.info.fps),
      next: index,
      lastUsed: this.tick,
    };
    this.cursors[slot] = c;
    return c;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (this.pending.size > 0 && !this.closed) {
        // Most urgent request first (the frame on screen, then the nearest ahead).
        let target = -1;
        let best = -Infinity;
        for (const [i, l] of this.pending) {
          const pr = Math.max(...l.map((p) => p.priority));
          if (pr > best || (pr === best && i < target)) {
            best = pr;
            target = i;
          }
        }
        const c = this.cursorFor(target);
        c.lastUsed = ++this.tick;
        const t0 = performance.now();
        const r = await c.iter.next();
        if (!this.cursors.includes(c)) {
          if (!r.done) r.value.close();
          continue;
        }
        if (r.done) {
          for (const [i, l] of this.pending) {
            if (i >= c.next) {
              for (const p of l) p.reject(new Error('End of stream'));
              this.pending.delete(i);
            }
          }
          this.cursors[this.cursors.indexOf(c)] = null;
          continue;
        }
        const sample = r.value;
        const idx = this.indexOf(sample.timestamp + sample.duration / 2 - 0.5 / this.info.fps);
        c.next = idx + 1;
        const waiting = this.pending.get(idx);
        if (!waiting && (idx < target || this.lookahead.has(idx))) {
          sample.close();
          continue;
        }
        const { pixels, bytes } = await samplePixels(sample);
        sample.close();
        const frame: FrameData = {
          index: idx,
          pixels,
          bytes,
          decodeMs: performance.now() - t0,
          release:
            pixels.kind === 'external' ? () => (pixels.source as VideoFrame).close() : undefined,
        };
        if (waiting) {
          this.pending.delete(idx);
          waiting[0].resolve(frame);
          for (const p of waiting.slice(1)) p.resolve({ ...frame, release: undefined });
        } else {
          this.lookahead.set(idx, frame);
          while (this.lookahead.size > 8) {
            const k = this.lookahead.keys().next().value as number;
            this.lookahead.get(k)?.release?.();
            this.lookahead.delete(k);
          }
        }
      }
    } catch (e) {
      for (const [, l] of this.pending) for (const p of l) p.reject(e);
      this.pending.clear();
      this.cursors = [null, null];
    } finally {
      this.pumping = false;
    }
  }

  dispose(): void {
    this.closed = true;
    for (const c of this.cursors) if (c) void c.iter.return(undefined);
    for (const f of this.lookahead.values()) f.release?.();
    this.lookahead.clear();
    this.input.dispose();
  }
}
