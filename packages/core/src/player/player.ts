import { Renderer, Surface, type SceneImage } from '../gpu/renderer.js';
import {
  ScopeEngine,
  defaultScopeOptions,
  type ScopeKind,
  type ScopeOptions,
} from '../gpu/scopes.js';
import {
  defaultDisplaySettings,
  type DisplaySettings,
  type ViewTransform,
} from '../gpu/settings.js';
import { detectHdrDisplay } from '../gpu/context.js';
import type { FrameData, FrameSource, MediaInfo } from '../media/types.js';
import { openMedia, type MediaInput, type OpenOptions } from '../media/open.js';
import { FrameCache } from './cache.js';
import { AudioPlayer } from './audio.js';
import * as color from '../color/index.js';
import {
  GradeHistory,
  applyGradeCPU,
  cloneGrade,
  defaultGrade,
  normalizeGrade,
  packGrade,
  type Grade,
  type GradeNode,
  type PackedGrade,
} from '../grade/index.js';

export type LoopMode = 'loop' | 'once' | 'pingpong';

export interface PlayerState {
  media: MediaInfo | null;
  mediaB: MediaInfo | null;
  loading: boolean;
  error: string | null;
  /** Zero-based frame index on screen. */
  frame: number;
  playing: boolean;
  /** Playback rate; negative plays backwards. */
  speed: number;
  loop: LoopMode;
  inPoint: number;
  outPoint: number;
  /** Drop frames to keep real time (true) or show every frame (false). */
  realtime: boolean;
  volume: number;
  muted: boolean;
  layer: string;
  view: ViewTransform;
  /** 'fit' keeps the image fitted on resize; 'manual' after the user zooms/pans. */
  fitMode: 'fit' | 'manual';
  /** Measured playback fps and decode time. */
  stats: {
    fps: number;
    decodeMs: number;
    dropped: number;
    cachedFrames: number;
    cacheBytes: number;
    gpuMs: number;
  };
  cacheVersion: number;
  hdrDisplay: boolean;
  /** Incremented on every grade change; read the grade with `getGrade()`. */
  gradeRevision: number;
  /** A/B against the same image without the grade (no second source needed). */
  compareOriginal: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface SetGradeOptions {
  /**
   * Undo behaviour: true (default) records a step, false doesn't, and a string records a step
   * that merges with the previous one carrying the same key (continuous drags).
   */
  history?: boolean | string;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export type GradeNodePatch = DeepPartial<Omit<GradeNode, 'id'>>;

export interface ProbeResult {
  x: number;
  y: number;
  /** Scene-linear ACEScg (after the input transform, before exposure). */
  scene: [number, number, number];
  /** After viewer exposure, the grade and the CDL (what enters the view transform). */
  graded: [number, number, number];
  alpha: number;
  /** Source value as stored in the file (before the input transform), when available. */
  source?: number[];
  /** Display signal after the view transform (0..1). */
  display: [number, number, number];
  /** Display luminance in nits (when the view is known). */
  nits?: number;
  /** Graded stops relative to 18% grey. */
  stops: number;
}

type Listener = (s: PlayerState, changed: Set<keyof PlayerState>) => void;

export interface PlayerOptions {
  /** CPU frame cache budget in MB (default: 25% of deviceMemory, 512..4096). */
  cacheMB?: number;
  /** Base URL for the ACES view LUTs (defaults to the files shipped next to the module). */
  lutBaseUrl?: string | URL;
  open?: OpenOptions;
}

const clampi = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * Headless player: owns the media source(s), frame cache, playback clock, GPU decode and every
 * surface (viewer canvas) and scope attached to it. The UI layer only calls methods and listens.
 */
export class Player {
  readonly settings: DisplaySettings = defaultDisplaySettings();
  readonly scopeOptions: ScopeOptions = defaultScopeOptions();
  state: PlayerState;

  private renderer: Renderer | null = null;
  private rendererReady: Promise<Renderer>;
  private scopes: ScopeEngine | null = null;
  private surfaces = new Map<HTMLCanvasElement | OffscreenCanvas, Surface>();
  private scopeCanvases = new Map<
    HTMLCanvasElement | OffscreenCanvas,
    { kind: ScopeKind; opts: Parameters<ScopeEngine['draw']>[2] }
  >();
  private listeners = new Set<Listener>();
  private source: FrameSource | null = null;
  private sourceB: FrameSource | null = null;
  private cache: FrameCache;
  private cacheB: FrameCache;
  private inflight = new Map<number, AbortController>();
  private inflightB = new Map<number, AbortController>();
  private sceneA: SceneImage | null = null;
  private sceneB: SceneImage | null = null;
  private sceneKeyA = '';
  private sceneKeyB = '';
  private recycle: GPUTexture[] = [];
  private audio = new AudioPlayer();
  private raf = 0;
  private clock = { t0: 0, f0: 0 };
  private lastShownAt = 0;
  private fpsWindow: number[] = [];
  private dirty = true;
  private scopesDirty = true;
  private lastScopes = 0;
  private lutCpu: { size: number; data: Uint16Array } | null = null;
  private viewInfo: color.ViewInfo | null = null;
  private loadToken = 0;
  private canvasSize = { width: 1, height: 1, dpr: 1 };
  private pingDir: 1 | -1 = 1;
  private disposed = false;
  private hdrQuery: MediaQueryList | null = null;

  constructor(private readonly options: PlayerOptions = {}) {
    const mem = (globalThis.navigator as unknown as { deviceMemory?: number })?.deviceMemory ?? 8;
    const mb = options.cacheMB ?? clampi(Math.round(mem * 1024 * 0.25), 512, 4096);
    this.cache = new FrameCache(mb * 1024 * 1024);
    this.cacheB = new FrameCache(Math.round((mb * 1024 * 1024) / 3));
    this.state = {
      media: null,
      mediaB: null,
      loading: false,
      error: null,
      frame: 0,
      playing: false,
      speed: 1,
      loop: 'loop',
      inPoint: 0,
      outPoint: 0,
      realtime: true,
      volume: 1,
      muted: false,
      layer: '',
      view: { zoom: 1, panX: 0, panY: 0 },
      fitMode: 'fit',
      stats: { fps: 0, decodeMs: 0, dropped: 0, cachedFrames: 0, cacheBytes: 0, gpuMs: 0 },
      cacheVersion: 0,
      hdrDisplay: detectHdrDisplay(),
      gradeRevision: 0,
      compareOriginal: false,
      canUndo: false,
      canRedo: false,
    };
    this.rendererReady = Renderer.create().then(async (r) => {
      this.renderer = r;
      this.scopes = new ScopeEngine(r);
      r.setGrade(this.packed);
      await this.applyView();
      this.dirty = true;
      this.kick();
      return r;
    });
    this.rendererReady.catch((e) => this.set({ error: String(e?.message ?? e) }));
    try {
      this.hdrQuery = matchMedia('(dynamic-range: high)');
      this.hdrQuery.addEventListener('change', this.onHdrChange);
    } catch {
      /* not a browser */
    }
  }

  private onHdrChange = () => {
    this.set({ hdrDisplay: detectHdrDisplay() });
    this.invalidate();
  };

  /** Resolves once WebGPU is initialised (rejects if it isn't available). */
  ready(): Promise<void> {
    return this.rendererReady.then(() => undefined);
  }

  // -------------------------------------------------------------------------------------------
  // Events / state
  // -------------------------------------------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state, new Set(Object.keys(this.state) as (keyof PlayerState)[]));
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<PlayerState>): void {
    const changed = new Set<keyof PlayerState>();
    for (const k of Object.keys(patch) as (keyof PlayerState)[]) {
      if (this.state[k] !== patch[k]) changed.add(k);
    }
    if (changed.size === 0) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state, changed);
  }

  // -------------------------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------------------------

  async load(input: MediaInput, opts: OpenOptions = {}): Promise<MediaInfo> {
    const token = ++this.loadToken;
    this.pause();
    this.set({ loading: true, error: null });
    try {
      const src = await openMedia(input, { ...this.options.open, ...opts });
      if (token !== this.loadToken) {
        src.dispose();
        throw new DOMException('Superseded', 'AbortError');
      }
      this.disposeSource();
      this.source = src;
      const info = src.info;
      if (info.colorHints.inputSpace && color.findInputSpace(info.colorHints.inputSpace)) {
        this.settings.inputSpace = info.colorHints.inputSpace;
      }
      this.set({
        media: info,
        loading: false,
        frame: 0,
        inPoint: 0,
        outPoint: info.frameCount - 1,
        layer: info.layers[0]?.name ?? '',
        fitMode: 'fit',
        stats: { ...this.state.stats, dropped: 0 },
      });
      this.fit();
      this.request(0);
      this.prefetch();
      return info;
    } catch (e) {
      if ((e as Error).name !== 'AbortError')
        this.set({ loading: false, error: (e as Error).message ?? String(e) });
      throw e;
    }
  }

  /**
   * Compares the image with itself without the grade: B = original, A = graded (wipe,
   * side by side or blend). Replaces any second source.
   */
  setCompareOriginal(on: boolean): void {
    if (on && this.sourceB) void this.loadCompare(null);
    if (on && this.settings.compare.mode === 'off') this.settings.compare.mode = 'wipe';
    if (!on && !this.sourceB) this.settings.compare.mode = 'off';
    this.set({ compareOriginal: on });
    this.invalidate();
    for (const fn of this.listeners) fn(this.state, new Set());
  }

  /** Loads a second source for A/B comparison (same frame numbering). Pass null to clear. */
  async loadCompare(input: MediaInput | null, opts: OpenOptions = {}): Promise<MediaInfo | null> {
    this.sourceB?.dispose();
    this.sourceB = null;
    this.cacheB.clear();
    this.sceneB = null;
    this.sceneKeyB = '';
    if (!input) {
      this.set({ mediaB: null });
      this.invalidate();
      return null;
    }
    const src = await openMedia(input, { ...this.options.open, ...opts });
    this.sourceB = src;
    this.set({ mediaB: src.info, compareOriginal: false });
    if (this.settings.compare.mode === 'off') this.settings.compare.mode = 'wipe';
    this.requestB(this.state.frame);
    this.invalidate();
    return src.info;
  }

  private disposeSource(): void {
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
    this.cache.clear();
    this.source?.dispose();
    this.source = null;
    this.sceneKeyA = '';
    this.sceneA = null;
    this.audio.stop();
  }

  // -------------------------------------------------------------------------------------------
  // Surfaces & scopes
  // -------------------------------------------------------------------------------------------

  async attach(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    const r = await this.rendererReady;
    if (!this.surfaces.has(canvas)) this.surfaces.set(canvas, r.createSurface(canvas));
    // resize() may have run before the surface existed.
    canvas.width = this.canvasSize.width;
    canvas.height = this.canvasSize.height;
    if (this.state.fitMode === 'fit') this.fit();
    this.invalidate();
  }

  detach(canvas: HTMLCanvasElement | OffscreenCanvas): void {
    this.surfaces.get(canvas)?.dispose();
    this.surfaces.delete(canvas);
  }

  /** Call when the viewer canvas changes size (CSS px + devicePixelRatio). */
  resize(cssWidth: number, cssHeight: number, dpr = globalThis.devicePixelRatio || 1): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    this.canvasSize = { width: w, height: h, dpr };
    for (const c of this.surfaces.keys()) {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
    if (this.state.fitMode === 'fit') this.fit();
    this.invalidate();
  }

  attachScope(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    kind: ScopeKind,
    opts: Parameters<ScopeEngine['draw']>[2] = {},
  ): void {
    this.scopeCanvases.set(canvas, { kind, opts });
    this.scopesDirty = true;
    this.kick();
  }

  detachScope(canvas: HTMLCanvasElement | OffscreenCanvas): void {
    this.scopeCanvases.delete(canvas);
    this.scopes?.release(canvas);
  }

  // -------------------------------------------------------------------------------------------
  // Display settings
  // -------------------------------------------------------------------------------------------

  /** Applies a partial settings change (deep-merged one level). */
  update(patch: Partial<DisplaySettings>): void {
    const prevInput = this.settings.inputSpace;
    const prevView = this.settings.view;
    for (const [k, raw] of Object.entries(patch) as [keyof DisplaySettings, unknown][]) {
      // Deep-copy plain data: callers may pass framework proxies (Svelte $state) or objects
      // they keep mutating; settings must stay structured-cloneable and owned by the player.
      const v = clonePlain(raw);
      const cur = this.settings[k];
      if (
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        cur &&
        typeof cur === 'object' &&
        !Array.isArray(cur)
      ) {
        Object.assign(cur as object, v);
      } else {
        (this.settings as unknown as Record<string, unknown>)[k] = v;
      }
    }
    if (this.settings.inputSpace !== prevInput) {
      this.sceneKeyA = '';
      this.sceneKeyB = '';
    }
    if (this.settings.view !== prevView) void this.applyView();
    this.invalidate();
    for (const fn of this.listeners) fn(this.state, new Set());
  }

  private async applyView(): Promise<void> {
    const r = this.renderer;
    if (!r) return;
    const id = this.settings.view;
    try {
      await r.setView(id, this.options.lutBaseUrl);
      if (!['raw', 'log-acescct', 'srgb-clamp'].includes(id)) {
        const l = await color.loadViewLut(id, this.options.lutBaseUrl);
        this.lutCpu = { size: l.size, data: l.data };
        this.viewInfo = l.info;
      } else {
        this.lutCpu = null;
        this.viewInfo = null;
      }
    } catch (e) {
      this.set({ error: `Could not load view "${id}": ${(e as Error).message}` });
    }
    this.invalidate();
  }

  /** Installs a .cube LUT (text) as look (ACEScct domain) or display LUT. */
  setUserLut(cubeText: string | null, position: 'acescct' | 'display' = 'acescct'): void {
    const r = this.renderer;
    if (!r) return;
    if (!cubeText) {
      r.setUserLut(null);
      this.update({ userLut: { enabled: false, position } });
      return;
    }
    const lut = color.parseCubeLut(cubeText);
    let size = lut.size;
    let data = lut.data;
    if (lut.is1D) {
      // Expand a 1D LUT into a 33³ 3D LUT so both share one GPU path.
      const n = 33;
      const out = new Float32Array(n * n * n * 4);
      const sample = (v: number, c: number) => {
        const t = clampi(v, 0, 1) * (lut.size - 1);
        const i = Math.floor(t);
        const j = Math.min(lut.size - 1, i + 1);
        const f = t - i;
        return data[i * 4 + c] * (1 - f) + data[j * 4 + c] * f;
      };
      for (let b = 0; b < n; b++)
        for (let g = 0; g < n; g++)
          for (let rr = 0; rr < n; rr++) {
            const o = (rr + g * n + b * n * n) * 4;
            out[o] = sample(rr / (n - 1), 0);
            out[o + 1] = sample(g / (n - 1), 1);
            out[o + 2] = sample(b / (n - 1), 2);
            out[o + 3] = 1;
          }
      size = n;
      data = out;
    }
    r.setUserLut({ size, data });
    this.update({ userLut: { enabled: true, position } });
  }

  // -------------------------------------------------------------------------------------------
  // View transform (zoom / pan)
  // -------------------------------------------------------------------------------------------

  private imageExtent(): { w: number; h: number } {
    const m = this.state.media;
    if (!m) return { w: 1, h: 1 };
    const pa = m.pixelAspectRatio || 1;
    const sbs =
      this.settings.compare.mode === 'side-by-side' && (this.sourceB || this.state.compareOriginal)
        ? 2
        : 1;
    return { w: m.width * pa * sbs, h: m.height };
  }

  fit(): void {
    const { w, h } = this.imageExtent();
    const { width: cw, height: ch } = this.canvasSize;
    const zoom = Math.min(cw / w, ch / h) * 0.96;
    this.set({
      view: { zoom, panX: (cw - w * zoom) / 2, panY: (ch - h * zoom) / 2 },
      fitMode: 'fit',
    });
    this.invalidate();
  }

  /** Zoom to `zoom` (image px -> device px) keeping the device-pixel `anchor` fixed. 1 = 1:1. */
  zoomTo(zoom: number, anchor?: { x: number; y: number }): void {
    const v = this.state.view;
    const a = anchor ?? { x: this.canvasSize.width / 2, y: this.canvasSize.height / 2 };
    const z = clampi(zoom, 0.01, 256);
    const ix = (a.x - v.panX) / v.zoom;
    const iy = (a.y - v.panY) / v.zoom;
    this.set({ view: { zoom: z, panX: a.x - ix * z, panY: a.y - iy * z }, fitMode: 'manual' });
    this.invalidate();
  }

  zoomBy(factor: number, anchor?: { x: number; y: number }): void {
    this.zoomTo(this.state.view.zoom * factor, anchor);
  }

  panBy(dx: number, dy: number): void {
    const v = this.state.view;
    this.set({ view: { ...v, panX: v.panX + dx, panY: v.panY + dy }, fitMode: 'manual' });
    this.invalidate();
  }

  /** Device-pixel canvas position -> display-window image pixel. */
  canvasToImage(x: number, y: number): { x: number; y: number } {
    const v = this.state.view;
    const pa = this.state.media?.pixelAspectRatio || 1;
    return { x: (x - v.panX) / (v.zoom * pa), y: (y - v.panY) / v.zoom };
  }

  get canvasDevicePixelRatio(): number {
    return this.canvasSize.dpr;
  }

  // -------------------------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------------------------

  play(): void {
    if (!this.source || this.state.playing) return;
    const m = this.source.info;
    if (m.frameCount <= 1) return;
    let f = this.state.frame;
    if (this.state.loop === 'once' && f >= this.state.outPoint && this.state.speed > 0)
      f = this.state.inPoint;
    this.clock = { t0: performance.now(), f0: f };
    this.pingDir = 1;
    this.set({ playing: true, frame: f, stats: { ...this.state.stats, dropped: 0 } });
    this.fpsWindow = [];
    this.prerollUntil = performance.now() + 1500;
    this.prefetch();
    this.kick();
  }

  pause(): void {
    if (!this.state.playing) return;
    this.audio.stop();
    this.set({ playing: false });
    this.prefetch();
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: number): void {
    const playing = this.state.playing;
    if (playing) this.clock = { t0: performance.now(), f0: this.state.frame };
    this.set({ speed });
    if (playing) this.startAudio();
  }

  setLoop(loop: LoopMode): void {
    this.set({ loop });
  }

  setRealtime(realtime: boolean): void {
    this.set({ realtime });
  }

  setInOut(inPoint: number | null, outPoint: number | null): void {
    const n = this.state.media?.frameCount ?? 1;
    const i = inPoint == null ? 0 : clampi(inPoint, 0, n - 1);
    const o = outPoint == null ? n - 1 : clampi(outPoint, i, n - 1);
    this.set({ inPoint: i, outPoint: o });
  }

  setVolume(v: number): void {
    this.audio.volume = v;
    this.set({ volume: v });
  }

  setMuted(m: boolean): void {
    this.audio.muted = m;
    this.set({ muted: m });
  }

  setLayer(layer: string): void {
    this.cache.clear();
    this.sceneKeyA = '';
    this.set({ layer });
    this.request(this.state.frame);
    this.prefetch();
  }

  seek(frame: number): void {
    const n = this.state.media?.frameCount ?? 1;
    const f = clampi(Math.round(frame), 0, n - 1);
    if (this.state.playing) {
      this.clock = { t0: performance.now(), f0: f };
      this.startAudio(f);
    }
    this.set({ frame: f });
    this.request(f);
    this.requestB(f);
    this.prefetch();
    this.invalidate();
  }

  step(delta: number): void {
    this.pause();
    const n = this.state.media?.frameCount ?? 1;
    let f = this.state.frame + delta;
    if (this.state.loop !== 'once') f = ((f % n) + n) % n;
    this.seek(f);
  }

  private startAudio(at = this.state.frame): void {
    this.audio.stop();
    const src = this.source;
    if (!src?.audio || !this.state.playing || this.state.speed !== 1) return;
    this.audio.volume = this.state.volume;
    this.audio.muted = this.state.muted;
    void this.audio.start(src.audio, at / src.info.fps);
  }

  // -------------------------------------------------------------------------------------------
  // Decoding / prefetch
  // -------------------------------------------------------------------------------------------

  private direction(): 1 | -1 {
    return this.state.speed < 0 || (this.state.loop === 'pingpong' && this.pingDir < 0) ? -1 : 1;
  }

  private request(i: number, priority = Infinity): void {
    const src = this.source;
    if (!src || this.cache.has(i) || this.inflight.has(i)) return;
    const ac = new AbortController();
    this.inflight.set(i, ac);
    const token = this.loadToken;
    src
      .getFrame(i, { signal: ac.signal, priority, layer: this.state.layer })
      .then((f) => {
        if (token !== this.loadToken || src !== this.source) {
          f.release?.();
          return;
        }
        this.cache.put(f, this.state.frame, this.direction(), src.info.frameCount);
        this.set({
          cacheVersion: this.cache.version,
          stats: {
            ...this.state.stats,
            decodeMs: f.decodeMs,
            cachedFrames: this.cache.size,
            cacheBytes: this.cache.usedBytes,
          },
        });
        if (i === this.state.frame) this.invalidate();
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError' && token === this.loadToken) {
          console.warn(`[scenegrade] frame ${i} failed:`, e);
          if (i === this.state.frame)
            this.set({ error: `Frame ${i}: ${(e as Error).message ?? e}` });
        }
      })
      .finally(() => {
        this.inflight.delete(i);
        this.prefetch();
      });
  }

  private requestB(i: number): void {
    const src = this.sourceB;
    if (!src) return;
    const j = clampi(i, 0, src.info.frameCount - 1);
    if (this.cacheB.has(j) || this.inflightB.has(j)) return;
    const ac = new AbortController();
    this.inflightB.set(j, ac);
    src
      .getFrame(j, { signal: ac.signal, layer: '' })
      .then((f) => {
        if (src !== this.sourceB) return f.release?.();
        this.cacheB.put(f, j, 1, src.info.frameCount);
        if (j === clampi(this.state.frame, 0, src.info.frameCount - 1)) this.invalidate();
      })
      .catch(() => undefined)
      .finally(() => this.inflightB.delete(j));
  }

  /** Keeps the decoders busy with the frames we're about to need. */
  private prefetch(): void {
    const src = this.source;
    if (!src) return;
    const n = src.info.frameCount;
    const dir = this.direction();
    const { inPoint, outPoint, playing, frame } = this.state;
    const maxInflight = src.parallelism * (src.info.randomAccess === 'cheap' ? 2 : 3);
    const ahead = playing ? Math.max(maxInflight * 2, Math.ceil(src.info.fps)) : 3;
    const avgBytes = this.cache.size ? this.cache.usedBytes / this.cache.size : 0;
    const budgetFrames = avgBytes ? Math.floor((this.cache.budgetBytes / avgBytes) * 0.9) : ahead;
    const limit = Math.min(ahead + (playing ? budgetFrames : 0), budgetFrames, n);

    // Cancel requests far from the playhead (after seeks).
    for (const [i, ac] of this.inflight) {
      const d = ((i - frame) * dir + n) % n;
      if (d > limit + maxInflight && i !== frame) {
        ac.abort();
        this.inflight.delete(i);
      }
    }
    let k = 0;
    for (let step = 0; step < limit && this.inflight.size < maxInflight; step++) {
      let i = frame + step * dir;
      if (i > outPoint || i < inPoint) {
        if (this.state.loop === 'once' || this.state.loop === 'pingpong') break;
        const span = outPoint - inPoint + 1;
        i = inPoint + ((((i - inPoint) % span) + span) % span);
      }
      if (!this.cache.has(i) && !this.inflight.has(i)) {
        this.request(i, limit - step);
        k++;
      }
    }
    if (!playing && src.info.randomAccess === 'cheap') {
      // Paused: also decode the previous frame for instant step-back.
      if (frame > 0 && !this.cache.has(frame - 1) && this.inflight.size < maxInflight)
        this.request(frame - 1, 1);
    }
    void k;
  }

  // -------------------------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------------------------

  /** Marks the image as needing a redraw. */
  invalidate(): void {
    this.dirty = true;
    this.scopesDirty = true;
    this.kick();
  }

  private kick(): void {
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (this.disposed) return;
    if (this.state.playing) this.advance(now);
    const animated =
      this.settings.zebra.high || this.settings.zebra.low || this.settings.clipping.nan;
    if (this.dirty || animated) this.draw(now);
    if (this.state.playing || animated) this.kick();
  };

  private prerollUntil = 0;

  private advance(now: number): void {
    const src = this.source!;
    const m = src.info;
    // Pre-roll: hold the clock (up to 1.5 s) until a few frames ahead are decoded.
    if (this.prerollUntil) {
      const need = Math.min(m.frameCount - 1, Math.max(4, src.parallelism * 2));
      const ready = this.cache.hasRun(this.state.frame, need, m.frameCount, this.direction());
      if (!ready && now < this.prerollUntil) {
        this.clock = { t0: now, f0: this.state.frame };
        return;
      }
      this.prerollUntil = 0;
      this.clock = { t0: now, f0: this.state.frame };
      this.startAudio();
    }
    const { inPoint, outPoint, loop, realtime } = this.state;
    const speed = this.state.speed;
    let target: number;
    const at = this.audio.mediaTime;
    if (this.audio.active && !Number.isNaN(at)) {
      target = Math.floor(at * m.fps + 1e-6);
    } else {
      const dir = loop === 'pingpong' ? this.pingDir : 1;
      target =
        this.clock.f0 + Math.floor(((now - this.clock.t0) / 1000) * m.fps * speed * dir + 1e-6);
    }

    // Loop handling.
    if (target > outPoint || target < inPoint) {
      if (loop === 'once') {
        target = clampi(target, inPoint, outPoint);
        this.show(target);
        this.pause();
        return;
      }
      if (loop === 'pingpong') {
        this.pingDir = target > outPoint ? -1 : 1;
        target = clampi(target, inPoint, outPoint);
        this.clock = { t0: now, f0: target };
        this.audio.stop();
      } else {
        target = speed >= 0 ? inPoint : outPoint;
        this.clock = { t0: now, f0: target };
        this.startAudio(target);
      }
    }

    const cur = this.state.frame;
    if (target === cur) return;
    if (this.cache.has(target)) {
      // Only count frames skipped in the play direction (not loop wrap-arounds).
      const skipped =
        (target - cur) * Math.sign(speed || 1) * (loop === 'pingpong' ? this.pingDir : 1) - 1;
      if (skipped > 0 && skipped < m.fps * 2)
        this.set({ stats: { ...this.state.stats, dropped: this.state.stats.dropped + skipped } });
      this.show(target);
      return;
    }
    if (!realtime) {
      // Every-frame mode: wait for the next frame and slide the clock.
      const next = cur + (speed >= 0 ? 1 : -1) * (loop === 'pingpong' ? this.pingDir : 1);
      if (this.cache.has(next)) this.show(next);
      this.clock = { t0: now, f0: this.state.frame };
      this.request(next);
      return;
    }
    // Real time: show the newest cached frame between current and target.
    const dir = target > cur ? 1 : -1;
    for (let i = target; i !== cur; i -= dir) {
      if (this.cache.has(i)) {
        const sk = (i - cur) * Math.sign(speed || 1) - 1;
        if (sk > 0)
          this.set({ stats: { ...this.state.stats, dropped: this.state.stats.dropped + sk } });
        this.show(i);
        break;
      }
    }
    this.request(target);
  }

  private show(i: number): void {
    const now = performance.now();
    if (this.lastShownAt) {
      this.fpsWindow.push(now - this.lastShownAt);
      if (this.fpsWindow.length > 30) this.fpsWindow.shift();
    }
    this.lastShownAt = now;
    const avg = this.fpsWindow.reduce((a, b) => a + b, 0) / (this.fpsWindow.length || 1);
    this.set({ frame: i, stats: { ...this.state.stats, fps: avg ? 1000 / avg : 0 } });
    this.requestB(i);
    this.prefetch();
    this.invalidate();
  }

  private sceneFor(which: 'a' | 'b'): SceneImage | null {
    const r = this.renderer!;
    const src = which === 'a' ? this.source : this.sourceB;
    const cache = which === 'a' ? this.cache : this.cacheB;
    if (!src) return null;
    const idx =
      which === 'a' ? this.state.frame : clampi(this.state.frame, 0, src.info.frameCount - 1);
    const f: FrameData | undefined = cache.get(idx);
    const current = which === 'a' ? this.sceneA : this.sceneB;
    if (!f) return current; // keep showing the previous frame until the new one arrives
    const key = `${idx}:${this.state.layer}:${this.settings.inputSpace}:${which}`;
    if ((which === 'a' ? this.sceneKeyA : this.sceneKeyB) === key && current) return current;
    // Recycle the previous scene texture when sizes match.
    let target: GPUTexture | undefined;
    if (current && current.width === f.pixels.width && current.height === f.pixels.height)
      target = current.texture;
    else if (current) this.recycle.push(current.texture);
    const scene = r.decode(f.pixels, {
      inputSpace:
        which === 'b'
          ? (this.settingsB.inputSpace ?? this.settings.inputSpace)
          : this.settings.inputSpace,
      key,
      pixelAspect: src.info.pixelAspectRatio,
      target,
      slot: which,
    });
    if (f.pixels.kind === 'external' && f.release) {
      // Browser frames can't be kept: drop from the cache once on the GPU.
      cache.delete(idx);
    }
    while (this.recycle.length > 2) this.recycle.shift()!.destroy();
    if (which === 'a') {
      this.sceneA = scene;
      this.sceneKeyA = key;
    } else {
      this.sceneB = scene;
      this.sceneKeyB = key;
    }
    return scene;
  }

  /** Settings override for the B side (its own input space). */
  readonly settingsB: { inputSpace?: string } = {};

  private draw(now: number): void {
    const r = this.renderer;
    if (!r) return;
    this.dirty = false;
    const a = this.sceneFor('a');
    const original = this.state.compareOriginal && !this.sourceB;
    const b = this.sourceB ? this.sceneFor('b') : original ? a : null;
    const t = now / 1000;
    for (const s of this.surfaces.values()) {
      s.render(this.settings, this.state.view, a, b, {
        time: t,
        hdrDisplay: this.state.hdrDisplay,
        bUngraded: original,
      });
    }
    // Scopes: every frame when paused, ~20 Hz while playing.
    if (
      a &&
      this.scopes &&
      this.scopeCanvases.size > 0 &&
      (this.scopesDirty || this.state.playing)
    ) {
      if (!this.state.playing || now - this.lastScopes > 50) {
        const needRgb = [...this.scopeCanvases.values()].some(
          (c) => c.kind === 'parade' || c.kind === 'waveform-rgb',
        );
        this.scopes.compute(a, this.settings, this.scopeOptions, needRgb);
        for (const [canvas, c] of this.scopeCanvases) this.scopes.draw(canvas, c.kind, c.opts);
        this.lastScopes = now;
        this.scopesDirty = false;
      }
    }
  }

  /** Updates scope drawing options (gain, channels...) and redraws. */
  updateScope(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    kind: ScopeKind,
    opts: Parameters<ScopeEngine['draw']>[2],
  ): void {
    this.scopeCanvases.set(canvas, { kind, opts });
    this.scopesDirty = true;
    this.invalidate();
  }

  // -------------------------------------------------------------------------------------------
  // Grade
  // -------------------------------------------------------------------------------------------

  private grade: Grade = defaultGrade();
  private packed: PackedGrade = packGrade(this.grade);
  private readonly history = new GradeHistory();

  /** A copy of the current grade (serialisable JSON). */
  getGrade(): Grade {
    return cloneGrade(this.grade);
  }

  /** Replaces the grade. Accepts any JSON; it is validated and completed with defaults. */
  setGrade(input: Grade | unknown, opts: SetGradeOptions = {}): void {
    const next = normalizeGrade(input);
    const h = opts.history ?? true;
    if (h !== false) this.history.record(this.grade, typeof h === 'string' ? h : undefined);
    this.applyGrade(next);
  }

  /** Deep-merges a patch into one node (by id, or the first node when omitted). */
  updateGradeNode(id: string | null, patch: GradeNodePatch, opts: SetGradeOptions = {}): void {
    const g = this.getGrade();
    const n = id == null ? g.nodes[0] : g.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`No grade node "${id}"`);
    deepMerge(
      n as unknown as Record<string, unknown>,
      clonePlain(patch) as Record<string, unknown>,
    );
    this.setGrade(g, opts);
  }

  /** Ends a coalesced edit (call on pointer up) so the next change is its own undo step. */
  commitGradeEdit(): void {
    this.history.break();
  }

  undo(): boolean {
    const g = this.history.undo(this.grade);
    if (g) this.applyGrade(g);
    return !!g;
  }

  redo(): boolean {
    const g = this.history.redo(this.grade);
    if (g) this.applyGrade(g);
    return !!g;
  }

  /** Clears the undo history (e.g. after loading a project). */
  clearGradeHistory(): void {
    this.history.clear();
    this.set({ canUndo: false, canRedo: false });
  }

  /** Graded scene value (ACEScg) of a scene value, as the GPU computes it before the view. */
  gradeCPU(acescg: [number, number, number]): [number, number, number] {
    return this.sceneGradeCPU(acescg);
  }

  private applyGrade(g: Grade): void {
    this.grade = g;
    this.packed = packGrade(g);
    this.renderer?.setGrade(this.packed);
    this.invalidate();
    this.set({
      gradeRevision: this.state.gradeRevision + 1,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
    });
  }

  /** CPU mirror of the shader's gradeScene(): viewer exposure/saturation, grade, CDL. */
  private sceneGradeCPU(scene: [number, number, number]): [number, number, number] {
    const s = this.settings;
    let c = scene.map((v) => v * Math.pow(2, s.exposure)) as [number, number, number];
    if (s.saturation !== 1) {
      const y = 0.2722287168 * c[0] + 0.6740817658 * c[1] + 0.0536895174 * c[2];
      c = c.map((v) => y + (v - y) * s.saturation) as [number, number, number];
    }
    c = applyGradeCPU(this.packed, c);
    if (s.cdl.enabled) {
      const cct = color.acescgToACEScct(c);
      c = color.acescctToACEScg(
        color.applyCDL(cct, {
          slope: s.cdl.slope,
          offset: s.cdl.offset,
          power: s.cdl.power,
          sat: s.cdl.saturation,
        }),
      ) as [number, number, number];
    }
    return c;
  }

  // -------------------------------------------------------------------------------------------
  // Pixel probe
  // -------------------------------------------------------------------------------------------

  /** Probe at a device-pixel canvas position. `radius` averages a (2r+1)² area. */
  async probe(canvasX: number, canvasY: number, radius = 0): Promise<ProbeResult | null> {
    const r = this.renderer;
    const a = this.sceneA;
    if (!r || !a) return null;
    const p = this.canvasToImage(canvasX, canvasY);
    const px = await r.readPixel(a, p.x, p.y, radius);
    if (!px) return null;
    const scene: [number, number, number] = [px[0], px[1], px[2]];
    const exposed = this.sceneGradeCPU(scene);
    let display: [number, number, number];
    const v = this.settings.view;
    if (v === 'raw' || v === 'log-acescct' || v === 'srgb-clamp')
      display = color.applyAnalyticViewCPU(v, exposed) as [number, number, number];
    else if (this.lutCpu)
      display = color.applyViewCPU(this.lutCpu, exposed) as [number, number, number];
    else display = exposed;
    const y = 0.2722287168 * exposed[0] + 0.6740817658 * exposed[1] + 0.0536895174 * exposed[2];
    let nits: number | undefined;
    if (this.viewInfo) {
      const n = color.displayToNits(this.viewInfo, display);
      nits = 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2];
    }
    // Raw source value (before the input transform) for float sources.
    let source: number[] | undefined;
    const f = this.cache.get(this.state.frame);
    if (f && (f.pixels.kind === 'rgba-half' || f.pixels.kind === 'rgba-float')) {
      const ix = Math.floor(p.x) - a.offsetX;
      const iy = Math.floor(p.y) - a.offsetY;
      if (ix >= 0 && iy >= 0 && ix < f.pixels.width && iy < f.pixels.height) {
        const o = (iy * f.pixels.width + ix) * 4;
        const d = f.pixels.data;
        source = [0, 1, 2, 3].map((c) =>
          f.pixels.kind === 'rgba-half' ? color.halfToFloat(d[o + c]) : d[o + c],
        );
      }
    }
    return {
      x: Math.floor(p.x),
      y: Math.floor(p.y),
      scene,
      graded: exposed,
      alpha: px[3],
      source,
      display,
      nits,
      stops: Math.log2(Math.max(y, 1e-10) / 0.18),
    };
  }

  /** Cached frame ranges (inclusive) for the timeline cache bar. */
  cachedRanges(): [number, number][] {
    return this.cache.ranges();
  }

  /** Current frame number as shown to the user (adds the source's first frame number). */
  get displayFrameNumber(): number {
    return this.state.frame + (this.state.media?.firstFrame ?? 0);
  }

  /** Captures the current viewer output as a PNG blob (display-referred, as seen). */
  async snapshot(canvas?: HTMLCanvasElement): Promise<Blob | null> {
    const c = canvas ?? ([...this.surfaces.keys()][0] as HTMLCanvasElement | undefined);
    if (!c || !('toBlob' in c)) return null;
    this.draw(performance.now());
    return new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.disposeSource();
    this.sourceB?.dispose();
    this.audio.dispose();
    for (const s of this.surfaces.values()) s.dispose();
    this.surfaces.clear();
    this.hdrQuery?.removeEventListener('change', this.onHdrChange);
    this.listeners.clear();
  }
}

function clonePlain<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clonePlain) as T;
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) o[k] = clonePlain((v as Record<string, unknown>)[k]);
    return o as T;
  }
  return v;
}

function deepMerge(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    const cur = dst[k];
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      cur &&
      typeof cur === 'object' &&
      !Array.isArray(cur)
    ) {
      deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) dst[k] = v;
  }
}
