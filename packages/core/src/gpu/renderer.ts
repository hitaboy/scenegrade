import type { FramePixels, Box2 } from '../media/types.js';
import { getGpu, configureCanvas, CANVAS_FORMAT, type GpuContext } from './context.js';
import { decodeShader, displayShader, type DecodeKind, type ColorWgsl } from './shaders.js';
import type { DisplaySettings, ViewTransform } from './settings.js';
import { PRIMARIES, rgbToRgb, type M3 } from './matrices.js';
import * as color from '../color/index.js';
import { CURVE_N } from '../grade/curves.js';
import { CURVE_ROWS, EMPTY_PACKED, type PackedGrade } from '../grade/pack.js';

/** A decoded frame living on the GPU as scene-linear ACEScg (rgba16float). */
export interface SceneImage {
  key: string;
  texture: GPUTexture;
  width: number;
  height: number;
  /** Data window offset relative to the display window origin. */
  offsetX: number;
  offsetY: number;
  displayWidth: number;
  displayHeight: number;
  pixelAspect: number;
  hasAlpha: boolean;
  bytes: number;
}

export interface ViewLutInfo {
  id: string;
  hdr: boolean;
  peakNits: number;
  primaries: 'rec709' | 'p3d65' | 'rec2020';
  encoding: string;
  size: number;
}

const ANALYTIC = new Set(['raw', 'log-acescct', 'srgb-clamp']);

const YUV_MATRIX: Record<string, [number, number]> = {
  bt709: [0.2126, 0.0722],
  bt2020: [0.2627, 0.0593],
  bt601: [0.299, 0.114],
  rgb: [0, 0],
};

const UNIFORM_VEC4S = 25;

/**
 * Owns GPU pipelines and resources shared by every surface (viewer canvas) of a player.
 */
export class Renderer {
  readonly gpu: GpuContext;
  readonly device: GPUDevice;
  readonly linearSampler: GPUSampler;
  readonly nearestSampler: GPUSampler;

  private decodePipelines = new Map<
    string,
    { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout }
  >();
  private displayPipelines = new Map<string, GPURenderPipeline>();
  private displayLayout: GPUBindGroupLayout;
  private sourceTextures = new Map<string, GPUTexture>();
  private decodeUniforms: GPUBuffer;
  private viewLut: { info: ViewLutInfo; texture: GPUTexture } | null = null;
  private viewLutLoads = new Map<string, Promise<{ info: ViewLutInfo; texture: GPUTexture }>>();
  private viewLutCache = new Map<string, { info: ViewLutInfo; texture: GPUTexture }>();
  private userLut: { texture: GPUTexture; size: number } | null = null;
  private dummy3d: GPUTexture;
  private dummy2d: GPUTexture;
  private dummyU32: GPUTexture;

  static async create(): Promise<Renderer> {
    return new Renderer(await getGpu());
  }

  private constructor(gpu: GpuContext) {
    this.gpu = gpu;
    this.device = gpu.device;
    const d = this.device;
    this.linearSampler = d.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
    this.nearestSampler = d.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
    this.decodeUniforms = d.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.dummy3d = d.createTexture({
      size: [2, 2, 2],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.dummy2d = d.createTexture({
      size: [1, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.dummyU32 = d.createTexture({
      size: [1, 1],
      format: 'r16uint',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });

    const tex = (
      binding: number,
      viewDimension: GPUTextureViewDimension = '2d',
    ): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
      texture: { sampleType: 'float', viewDimension },
    });
    this.displayLayout = d.createBindGroupLayout({
      label: 'display',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        tex(1),
        tex(2),
        tex(3, '3d'),
        tex(4, '3d'),
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' },
        },
        {
          binding: 6,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' },
        },
        {
          binding: 7,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 8,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
      ],
    });
    this.setGrade(EMPTY_PACKED);
  }

  // -------------------------------------------------------------------------------------------
  // Grade (packed params + curve table, read by sl_grade in the display and scope shaders)
  // -------------------------------------------------------------------------------------------

  private gradeBuf!: GPUBuffer;
  private gradeTex!: GPUTexture;
  /** Bumped whenever the grade buffer or texture objects are replaced (bind groups must rebuild). */
  gradeVersion = 0;

  setGrade(p: PackedGrade): void {
    const d = this.device;
    const bytes = Math.max(16, p.params.byteLength);
    if (!this.gradeBuf || this.gradeBuf.size < bytes) {
      this.gradeBuf?.destroy();
      this.gradeBuf = d.createBuffer({
        label: 'grade-params',
        size: Math.max(bytes, 4096),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.gradeVersion++;
    }
    d.queue.writeBuffer(this.gradeBuf, 0, p.params as Float32Array<ArrayBuffer>);
    const rows = Math.max(1, p.rows);
    if (!this.gradeTex || this.gradeTex.height < rows) {
      this.gradeTex?.destroy();
      this.gradeTex = d.createTexture({
        label: 'grade-curves',
        size: [CURVE_N, Math.max(rows, CURVE_ROWS)],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.gradeVersion++;
    }
    if (p.curves.length) {
      d.queue.writeTexture(
        { texture: this.gradeTex },
        p.curves as Float32Array<ArrayBuffer>,
        { bytesPerRow: CURVE_N * 4, rowsPerImage: rows },
        [CURVE_N, rows],
      );
    }
  }

  get displayBindGroupLayout(): GPUBindGroupLayout {
    return this.displayLayout;
  }

  colorWgsl(falseColorPreset: string): ColorWgsl {
    return {
      common: color.COMMON_WGSL,
      cdl: color.CDL_WGSL,
      falseColor:
        color.falseColorWGSL(
          (falseColorPreset === 'ire' ? 'arri-like' : falseColorPreset) as color.FalseColorPreset,
        ) + color.falseColorWGSL('ire'),
    };
  }

  // ------------------------------------------------------------------------------------------
  // View transforms (3D LUTs)
  // ------------------------------------------------------------------------------------------

  /** Loads (or reuses) the LUT for a view and makes it current. Analytic views need no LUT. */
  async setView(id: string, baseUrl?: string | URL): Promise<ViewLutInfo | null> {
    if (ANALYTIC.has(id)) return null;
    const cached = this.viewLutCache.get(id);
    if (cached) {
      this.viewLut = cached;
      return cached.info;
    }
    let p = this.viewLutLoads.get(id);
    if (!p) {
      p = color.loadViewLut(id, baseUrl).then(({ info, size, data }) => {
        const texture = this.device.createTexture({
          label: `view-lut:${id}`,
          size: [size, size, size],
          dimension: '3d',
          format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.device.queue.writeTexture(
          { texture },
          data as Uint16Array<ArrayBuffer>,
          { bytesPerRow: size * 8, rowsPerImage: size },
          [size, size, size],
        );
        const entry = {
          info: {
            id,
            hdr: info.hdr,
            peakNits: info.peakNits,
            primaries: info.primaries,
            encoding: info.encoding,
            size,
          },
          texture,
        };
        this.viewLutCache.set(id, entry);
        return entry;
      });
      this.viewLutLoads.set(id, p);
    }
    const entry = await p;
    this.viewLut = entry;
    return entry.info;
  }

  get currentView(): ViewLutInfo | null {
    return this.viewLut?.info ?? null;
  }

  /** Installs a user look/display LUT (RGBA float data, r fastest). Pass null to remove. */
  setUserLut(lut: { size: number; data: Float32Array } | null): void {
    this.userLut?.texture.destroy();
    this.userLut = null;
    if (!lut) return;
    const n = lut.size;
    const half = new Uint16Array(n * n * n * 4);
    for (let i = 0; i < half.length; i++) half[i] = color.floatToHalf(lut.data[i]);
    const texture = this.device.createTexture({
      label: 'user-lut',
      size: [n, n, n],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture }, half, { bytesPerRow: n * 8, rowsPerImage: n }, [
      n,
      n,
      n,
    ]);
    this.userLut = { texture, size: n };
  }

  get hasUserLut(): boolean {
    return !!this.userLut;
  }

  // ------------------------------------------------------------------------------------------
  // Decode pass: FramePixels -> SceneImage
  // ------------------------------------------------------------------------------------------

  private decodePipeline(kind: DecodeKind, sub: string, inputSpace: string) {
    const key = `${kind}:${sub}:${inputSpace}`;
    let entry = this.decodePipelines.get(key);
    if (entry) return entry;
    const d = this.device;
    const code = decodeShader(kind, color.inputTransformWGSL(inputSpace));
    const module = d.createShaderModule({ label: `decode:${key}`, code });
    const vis = GPUShaderStage.FRAGMENT;
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: vis, buffer: { type: 'uniform' } },
    ];
    if (kind === 'rgba') {
      entries.push({
        binding: 1,
        visibility: vis,
        texture: { sampleType: sub === 'f32' ? 'unfilterable-float' : 'float' },
      });
    } else if (kind === 'external') {
      entries.push({ binding: 1, visibility: vis, externalTexture: {} });
      entries.push({ binding: 2, visibility: vis, sampler: { type: 'filtering' } });
    } else {
      for (let b = 1; b <= 4; b++)
        entries.push({ binding: b, visibility: vis, texture: { sampleType: 'uint' } });
    }
    const layout = d.createBindGroupLayout({ label: `decode:${key}`, entries });
    const pipeline = d.createRenderPipeline({
      label: `decode:${key}`,
      layout: d.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
    entry = { pipeline, layout };
    this.decodePipelines.set(key, entry);
    return entry;
  }

  private sourceTexture(
    slot: string,
    w: number,
    h: number,
    format: GPUTextureFormat,
    extraUsage = 0,
  ): GPUTexture {
    const key = `${slot}:${w}x${h}:${format}`;
    let t = this.sourceTextures.get(key);
    if (!t) {
      // Drop textures of other sizes in this slot (resolution changes).
      for (const [k, old] of this.sourceTextures) {
        if (k.startsWith(`${slot}:`)) {
          old.destroy();
          this.sourceTextures.delete(k);
        }
      }
      t = this.device.createTexture({
        label: key,
        size: [w, h],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | extraUsage,
      });
      this.sourceTextures.set(key, t);
    }
    return t;
  }

  createSceneTexture(w: number, h: number): GPUTexture {
    return this.device.createTexture({
      label: `scene ${w}x${h}`,
      size: [w, h],
      format: 'rgba16float',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
  }

  /**
   * Uploads a frame and converts it to scene-linear ACEScg.
   * @param target optional existing scene texture of the right size to render into (recycling).
   */
  decode(
    px: FramePixels,
    opts: {
      inputSpace: string;
      key: string;
      pixelAspect?: number;
      target?: GPUTexture;
      slot?: string;
    },
  ): SceneImage {
    const d = this.device;
    const slot = opts.slot ?? 'a';
    const { width: w, height: h } = px;
    const target =
      opts.target && opts.target.width === w && opts.target.height === h
        ? opts.target
        : this.createSceneTexture(w, h);

    const u = new Float32Array(12);
    u[0] = w;
    u[1] = h;
    u[11] = 1; // apply input transform
    let kind: DecodeKind;
    let sub = '';
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.decodeUniforms } },
    ];
    let dw: Box2 = { xMin: 0, yMin: 0, xMax: w - 1, yMax: h - 1 };
    let disp: Box2 = dw;
    let hasAlpha = px.hasAlpha;

    switch (px.kind) {
      case 'rgba-half':
      case 'rgba-float': {
        kind = 'rgba';
        const half = px.kind === 'rgba-half';
        sub = half ? 'f16' : 'f32';
        const fmt: GPUTextureFormat = half ? 'rgba16float' : 'rgba32float';
        const t = this.sourceTexture(`${slot}-rgba`, w, h, fmt);
        d.queue.writeTexture(
          { texture: t },
          px.data as Uint16Array<ArrayBuffer>,
          { bytesPerRow: w * (half ? 8 : 16), rowsPerImage: h },
          [w, h],
        );
        entries.push({ binding: 1, resource: t.createView() });
        dw = px.dataWindow;
        disp = px.displayWindow;
        break;
      }
      case 'rgba8': {
        kind = 'rgba';
        sub = 'u8';
        const t = this.sourceTexture(`${slot}-rgba8`, w, h, 'rgba8unorm');
        d.queue.writeTexture(
          { texture: t },
          px.data as Uint8Array<ArrayBuffer>,
          { bytesPerRow: w * 4, rowsPerImage: h },
          [w, h],
        );
        entries.push({ binding: 1, resource: t.createView() });
        break;
      }
      case 'external': {
        if (typeof VideoFrame !== 'undefined' && px.source instanceof VideoFrame) {
          kind = 'external';
          const ext = d.importExternalTexture({ source: px.source, colorSpace: 'srgb' });
          entries.push({ binding: 1, resource: ext });
          entries.push({ binding: 2, resource: this.linearSampler });
        } else {
          kind = 'rgba';
          sub = 'u8';
          const t = this.sourceTexture(
            `${slot}-bitmap`,
            w,
            h,
            'rgba8unorm',
            GPUTextureUsage.RENDER_ATTACHMENT,
          );
          d.queue.copyExternalImageToTexture(
            { source: px.source as ImageBitmap },
            { texture: t, premultipliedAlpha: false },
            [w, h],
          );
          entries.push({ binding: 1, resource: t.createView() });
        }
        break;
      }
      case 'yuv': {
        kind = 'yuv';
        const deep = px.bitDepth > 8;
        const fmt: GPUTextureFormat = deep ? 'r16uint' : 'r8uint';
        const bpp = deep ? 2 : 1;
        const cw = px.chroma === '444' ? w : Math.ceil(w / 2);
        const ch = px.chroma === '420' ? Math.ceil(h / 2) : h;
        const dims: [number, number][] = [
          [w, h],
          [cw, ch],
          [cw, ch],
          [w, h],
        ];
        for (let i = 0; i < 4; i++) {
          const plane = px.planes[i];
          if (!plane) {
            entries.push({ binding: i + 1, resource: this.dummyU32.createView() });
            continue;
          }
          const [pw, ph] = dims[i];
          const t = this.sourceTexture(`${slot}-yuv${i}`, pw, ph, fmt);
          d.queue.writeTexture(
            { texture: t },
            plane.data as Uint8Array<ArrayBuffer>,
            { bytesPerRow: plane.stride, rowsPerImage: ph },
            [pw, ph],
          );
          void bpp;
          entries.push({ binding: i + 1, resource: t.createView() });
        }
        const [kr, kb] = YUV_MATRIX[px.matrix] ?? YUV_MATRIX.bt709;
        u[4] = px.bitDepth;
        u[5] = px.fullRange ? 1 : 0;
        u[6] = px.chroma === '444' ? 0 : px.chroma === '422' ? 1 : 2;
        u[7] = px.hasAlpha && px.planes[3] ? 1 : 0;
        u[8] = kr;
        u[9] = kb;
        u[10] = px.matrix === 'rgb' ? 1 : 0;
        hasAlpha = px.hasAlpha && !!px.planes[3];
        break;
      }
    }

    d.queue.writeBuffer(this.decodeUniforms, 0, u);
    const { pipeline, layout } = this.decodePipeline(kind, sub, opts.inputSpace);
    const bg = d.createBindGroup({ layout, entries });
    const enc = d.createCommandEncoder({ label: 'decode' });
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
    d.queue.submit([enc.finish()]);

    return {
      key: opts.key,
      texture: target,
      width: w,
      height: h,
      offsetX: dw.xMin - disp.xMin,
      offsetY: dw.yMin - disp.yMin,
      displayWidth: disp.xMax - disp.xMin + 1,
      displayHeight: disp.yMax - disp.yMin + 1,
      pixelAspect: opts.pixelAspect ?? 1,
      hasAlpha,
      bytes: w * h * 8,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Display pass
  // ------------------------------------------------------------------------------------------

  displayPipeline(falseColorPreset: string): GPURenderPipeline {
    let p = this.displayPipelines.get(falseColorPreset);
    if (p) return p;
    const module = this.device.createShaderModule({
      label: 'display',
      code: displayShader(this.colorWgsl(falseColorPreset)),
    });
    p = this.device.createRenderPipeline({
      label: 'display',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.displayLayout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: CANVAS_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this.displayPipelines.set(falseColorPreset, p);
    return p;
  }

  /** Builds the bind group shared by display and scopes. */
  displayBindGroup(uniforms: GPUBuffer, a: SceneImage | null, b: SceneImage | null): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.displayLayout,
      entries: [
        { binding: 0, resource: { buffer: uniforms } },
        { binding: 1, resource: (a?.texture ?? this.dummy2d).createView() },
        { binding: 2, resource: (b?.texture ?? a?.texture ?? this.dummy2d).createView() },
        { binding: 3, resource: (this.viewLut?.texture ?? this.dummy3d).createView() },
        { binding: 4, resource: (this.userLut?.texture ?? this.dummy3d).createView() },
        { binding: 5, resource: this.linearSampler },
        { binding: 6, resource: this.nearestSampler },
        { binding: 7, resource: { buffer: this.gradeBuf } },
        { binding: 8, resource: this.gradeTex.createView() },
      ],
    });
  }

  /** Packs DisplaySettings + view into the uniform layout declared in shaders.ts. */
  packUniforms(
    s: DisplaySettings,
    view: ViewTransform,
    canvas: { width: number; height: number },
    a: SceneImage | null,
    b: SceneImage | null,
    out: {
      hdrOutput: boolean;
      canvasPrimaries: 'srgb' | 'display-p3';
      time: number;
      /** B is the A image shown without the grade (compare with original). */
      bUngraded?: boolean;
    },
  ): ArrayBuffer {
    const buf = new ArrayBuffer(UNIFORM_VEC4S * 16);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    const set4 = (i: number, x: number, y: number, z: number, w: number) => {
      f[i * 4] = x;
      f[i * 4 + 1] = y;
      f[i * 4 + 2] = z;
      f[i * 4 + 3] = w;
    };
    const setU = (i: number, x: number, y: number, z: number, w: number) => {
      u[i * 4] = x;
      u[i * 4 + 1] = y;
      u[i * 4 + 2] = z;
      u[i * 4 + 3] = w;
    };
    const img = (i: number, im: SceneImage | null) =>
      im ? set4(i, im.width, im.height, im.offsetX, im.offsetY) : set4(i, 1, 1, 0, 0);

    const pa = a?.pixelAspect ?? 1;
    set4(0, canvas.width, canvas.height, 1 / canvas.width, 1 / canvas.height);
    set4(1, view.zoom, view.panX, view.panY, pa);
    img(2, a);
    img(3, b ?? a);
    set4(4, a?.displayWidth ?? 1, a?.displayHeight ?? 1, s.displayWindowOutline ? 1 : 0, 0.6);
    set4(5, Math.pow(2, s.exposure), s.gamma, s.saturation, out.time);

    const channel = { rgb: 0, r: 1, g: 2, b: 3, a: 4, luma: 5 }[s.channel];
    const viewMode =
      s.view === 'raw' ? 1 : s.view === 'log-acescct' ? 2 : s.view === 'srgb-clamp' ? 3 : 0;
    const lut = this.viewLut?.info;
    const hdrView = viewMode === 0 && !!lut?.hdr;
    const outputMode =
      hdrView && out.hdrOutput ? (lut?.encoding === 'pq' ? 1 : lut?.encoding === 'hlg' ? 2 : 0) : 0;
    const bg = { black: 0, checker: 1, solid: 2 }[s.background];
    setU(6, channel, viewMode, outputMode, bg);

    const fc = { off: 0, stops: 1, ire: 2 }[s.falseColor];
    const zebra = (s.zebra.high ? 1 : 0) | (s.zebra.low ? 2 : 0);
    const clip = (s.clipping.over ? 1 : 0) | (s.clipping.under ? 2 : 0) | (s.clipping.nan ? 4 : 0);
    setU(7, fc, zebra, clip, s.peaking.enabled ? 1 : 0);

    const cmp = b
      ? { off: 0, wipe: 1, 'side-by-side': 2, difference: 3, blend: 4 }[s.compare.mode]
      : 0;
    const userLutMode =
      s.userLut.enabled && this.userLut ? (s.userLut.position === 'acescct' ? 1 : 2) : 0;
    const nearest = s.filter === 'nearest' || (s.filter === 'auto' && view.zoom >= 1.999) ? 1 : 0;
    setU(8, cmp, userLutMode, s.cdl.enabled ? 1 : 0, nearest);

    set4(9, s.zebra.highThreshold, s.zebra.lowThreshold, s.zebra.stripeWidth, s.zebra.lowBand);
    set4(10, s.compare.wipe, s.compare.angle, s.compare.diffGain, s.compare.blend);
    set4(11, ...s.cdl.slope, 0);
    set4(12, ...s.cdl.offset, 0);
    set4(13, ...s.cdl.power, s.cdl.saturation);
    set4(14, s.hdr.referenceWhite, lut?.peakNits ?? 100, 0, 0);
    set4(15, lut?.size ?? 2, this.userLut?.size ?? 2, out.bUngraded ? 1 : 0, 0);
    set4(16, ...s.peaking.color, s.peaking.threshold);
    set4(17, ...s.backgroundColor, 1);

    const prim = lut?.primaries ?? 'rec709';
    const from =
      prim === 'rec2020'
        ? PRIMARIES.rec2020
        : prim === 'p3d65'
          ? PRIMARIES.p3d65
          : PRIMARIES.rec709;
    const to = out.canvasPrimaries === 'display-p3' ? PRIMARIES.p3d65 : PRIMARIES.rec709;
    const om: M3 = rgbToRgb(from, to);
    set4(18, om[0], om[1], om[2], 0);
    set4(19, om[3], om[4], om[5], 0);
    set4(20, om[6], om[7], om[8], 0);
    const rm: M3 = rgbToRgb(PRIMARIES.ap1, PRIMARIES.rec709);
    set4(21, rm[0], rm[1], rm[2], 0);
    set4(22, rm[3], rm[4], rm[5], 0);
    set4(23, rm[6], rm[7], rm[8], 0);
    const bb = b ?? a;
    set4(24, bb?.displayWidth ?? 1, bb?.displayHeight ?? 1, 0, 0);
    return buf;
  }

  createUniformBuffer(): GPUBuffer {
    return this.device.createBuffer({
      size: UNIFORM_VEC4S * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** Reads one texel (scene-linear ACEScg + alpha) from a scene image. */
  async readPixel(
    img: SceneImage,
    x: number,
    y: number,
    radius = 0,
  ): Promise<[number, number, number, number] | null> {
    const ix = Math.floor(x - img.offsetX);
    const iy = Math.floor(y - img.offsetY);
    if (ix < 0 || iy < 0 || ix >= img.width || iy >= img.height) return null;
    const x0 = Math.max(0, ix - radius),
      y0 = Math.max(0, iy - radius);
    const x1 = Math.min(img.width - 1, ix + radius),
      y1 = Math.min(img.height - 1, iy + radius);
    const w = x1 - x0 + 1,
      h = y1 - y0 + 1;
    const bytesPerRow = Math.ceil((w * 8) / 256) * 256;
    const buf = this.device.createBuffer({
      size: bytesPerRow * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: img.texture, origin: [x0, y0] },
      { buffer: buf, bytesPerRow },
      [w, h],
    );
    this.device.queue.submit([enc.finish()]);
    try {
      await buf.mapAsync(GPUMapMode.READ);
    } catch {
      buf.destroy();
      return null;
    }
    const data = new Uint16Array(buf.getMappedRange());
    const acc = [0, 0, 0, 0];
    let n = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const o = (j * bytesPerRow) / 2 + i * 4;
        for (let c = 0; c < 4; c++) acc[c] += color.halfToFloat(data[o + c]);
        n++;
      }
    }
    buf.unmap();
    buf.destroy();
    return [acc[0] / n, acc[1] / n, acc[2] / n, acc[3] / n];
  }

  createSurface(canvas: HTMLCanvasElement | OffscreenCanvas): Surface {
    return new Surface(this, canvas);
  }
}

/** One canvas showing a player's image. */
export class Surface {
  readonly ctx: GPUCanvasContext;
  private uniforms: GPUBuffer;
  private configured = '';
  private bindGroup: GPUBindGroup | null = null;
  private bindKey = '';

  constructor(
    readonly renderer: Renderer,
    readonly canvas: HTMLCanvasElement | OffscreenCanvas,
  ) {
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('Could not create a WebGPU canvas context');
    this.ctx = ctx as GPUCanvasContext;
    this.uniforms = renderer.createUniformBuffer();
  }

  /** Canvas primaries for the current view: Display P3 views/HDR use a display-p3 canvas. */
  render(
    s: DisplaySettings,
    view: ViewTransform,
    a: SceneImage | null,
    b: SceneImage | null,
    opts: { time: number; hdrDisplay: boolean; bUngraded?: boolean },
  ): void {
    const r = this.renderer;
    const lut = r.currentView;
    const viewIsLut = !['raw', 'log-acescct', 'srgb-clamp'].includes(s.view);
    const hdrOutput = viewIsLut && !!lut?.hdr && s.hdr.enabled && opts.hdrDisplay;
    const p3 = hdrOutput || (viewIsLut && lut?.primaries === 'p3d65' && !lut.hdr);
    const colorSpace: PredefinedColorSpace = p3 ? 'display-p3' : 'srgb';
    const cfgKey = `${colorSpace}:${hdrOutput}`;
    if (cfgKey !== this.configured) {
      configureCanvas(this.ctx, r.device, { colorSpace, hdr: hdrOutput });
      this.configured = cfgKey;
    }
    const data = r.packUniforms(s, view, this.canvas, a, b, {
      hdrOutput,
      canvasPrimaries: colorSpace,
      time: opts.time,
      bUngraded: opts.bUngraded,
    });
    r.device.queue.writeBuffer(this.uniforms, 0, data);

    const key = `${a?.texture.label}:${a?.key}:${b?.key}:${lut?.id}:${r.hasUserLut}:${r.gradeVersion}`;
    if (!this.bindGroup || key !== this.bindKey) {
      this.bindGroup = r.displayBindGroup(this.uniforms, a, b);
      this.bindKey = key;
    }
    const enc = r.device.createCommandEncoder({ label: 'display' });
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.ctx.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [s.backgroundColor[0], s.backgroundColor[1], s.backgroundColor[2], 1],
        },
      ],
    });
    if (a) {
      pass.setPipeline(r.displayPipeline(s.falseColorPreset));
      pass.setBindGroup(0, this.bindGroup);
      pass.draw(3);
    }
    pass.end();
    r.device.queue.submit([enc.finish()]);
  }

  /** Forces the bind group to be rebuilt (e.g. after a scene texture was recycled). */
  invalidate(): void {
    this.bindGroup = null;
  }

  dispose(): void {
    this.uniforms.destroy();
    this.ctx.unconfigure();
  }
}
