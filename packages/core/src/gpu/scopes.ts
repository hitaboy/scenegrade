import type { Renderer, SceneImage } from './renderer.js';
import type { DisplaySettings } from './settings.js';
import { scopeComputeShader, SCOPE_RENDER_WGSL } from './shaders.js';
import { configureCanvas } from './context.js';

export type ScopeKind = 'histogram' | 'waveform' | 'parade' | 'waveform-rgb' | 'vectorscope';

export interface ScopeOptions {
  /** Histogram domain: display signal (0..1) or scene-linear stops around 18% grey. */
  histogramMode: 'display' | 'stops';
  stopsRange: [number, number];
  /** Waveform vertical range in display signal units (0..1 = 0..100%). */
  waveformRange: [number, number];
  /** Sample grid width (height follows the aspect ratio). Lower = faster. */
  sampleWidth: number;
}

export const defaultScopeOptions = (): ScopeOptions => ({
  histogramMode: 'display',
  stopsRange: [-8, 8],
  waveformRange: [0, 1],
  sampleWidth: 512,
});

/**
 * Computes every scope in one compute dispatch from the current scene image and display settings,
 * then draws each into its own canvas. Scopes always reflect the exact display chain (view LUT, CDL,
 * exposure) because they share the WGSL with the viewer.
 */
export class ScopeEngine {
  private pipelines = new Map<string, GPUComputePipeline>();
  private scopeLayout: GPUBindGroupLayout;
  private renderLayout: GPUBindGroupLayout;
  private renderPipeline: GPURenderPipeline;
  private hist: GPUBuffer;
  private wave: GPUBuffer;
  private vect: GPUBuffer;
  private stats: GPUBuffer;
  private su: GPUBuffer;
  private du: GPUBuffer;
  private renderBindGroup: GPUBindGroup;
  private views = new Map<
    HTMLCanvasElement | OffscreenCanvas,
    { ctx: GPUCanvasContext; ub: GPUBuffer; bg: GPUBindGroup }
  >();
  /** Last histogram readback (for numeric stats in the UI). */
  lastStats: { samples: number } = { samples: 0 };

  constructor(private readonly r: Renderer) {
    const d = r.device;
    const st = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type },
    });
    this.scopeLayout = d.createBindGroupLayout({
      label: 'scopes',
      entries: [
        st(0, 'uniform'),
        st(1, 'storage'),
        st(2, 'storage'),
        st(3, 'storage'),
        st(4, 'storage'),
      ],
    });
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.hist = d.createBuffer({ label: 'hist', size: 4 * 256 * 4, usage });
    this.wave = d.createBuffer({ label: 'wave', size: 3 * 512 * 256 * 4, usage });
    this.vect = d.createBuffer({ label: 'vect', size: 256 * 256 * 4, usage });
    this.stats = d.createBuffer({ label: 'stats', size: 8 * 4, usage });
    this.su = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.du = r.createUniformBuffer();

    const fr = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type },
    });
    this.renderLayout = d.createBindGroupLayout({
      label: 'scope-render',
      entries: [
        fr(0, 'uniform'),
        fr(1, 'read-only-storage'),
        fr(2, 'read-only-storage'),
        fr(3, 'read-only-storage'),
        fr(4, 'read-only-storage'),
      ],
    });
    const module = d.createShaderModule({ label: 'scope-render', code: SCOPE_RENDER_WGSL });
    this.renderPipeline = d.createRenderPipeline({
      label: 'scope-render',
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.renderLayout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    });
    this.renderBindGroup = null as unknown as GPUBindGroup;
  }

  private pipeline(): GPUComputePipeline {
    const key = 'main';
    let p = this.pipelines.get(key);
    if (!p) {
      const module = this.r.device.createShaderModule({
        label: 'scopes',
        code: scopeComputeShader(this.r.colorWgsl('arri-like')),
      });
      p = this.r.device.createComputePipeline({
        label: 'scopes',
        layout: this.r.device.createPipelineLayout({
          bindGroupLayouts: [this.r.displayBindGroupLayout, this.scopeLayout],
        }),
        compute: { module, entryPoint: 'main' },
      });
      this.pipelines.set(key, p);
    }
    return p;
  }

  /** Runs the scope compute pass. Cost scales with `sampleWidth²`, not with the image size. */
  compute(scene: SceneImage, s: DisplaySettings, o: ScopeOptions, waveformRgb: boolean): void {
    const r = this.r;
    const d = r.device;
    const gw = Math.min(o.sampleWidth, scene.width);
    const gh = Math.max(
      1,
      Math.round((gw * scene.height) / scene.width / (scene.pixelAspect || 1)),
    );
    const ub = new ArrayBuffer(32);
    const u = new Uint32Array(ub);
    const f = new Float32Array(ub);
    u[0] = gw;
    u[1] = gh;
    u[2] = o.histogramMode === 'display' ? 0 : 1;
    u[3] = waveformRgb ? 1 : 0;
    f[4] = o.waveformRange[0];
    f[5] = o.waveformRange[1];
    f[6] = o.stopsRange[0];
    f[7] = o.stopsRange[1];
    d.queue.writeBuffer(this.su, 0, ub);
    // Scopes ignore overlays, compare and zoom: pack with a neutral view.
    const scopeSettings: DisplaySettings = {
      ...s,
      falseColor: 'off',
      compare: { ...s.compare, mode: 'off' },
    };
    d.queue.writeBuffer(
      this.du,
      0,
      r.packUniforms(
        scopeSettings,
        { zoom: 1, panX: 0, panY: 0 },
        { width: scene.width, height: scene.height },
        scene,
        null,
        {
          hdrOutput: false,
          canvasPrimaries: 'srgb',
          time: 0,
        },
      ),
    );

    const enc = d.createCommandEncoder({ label: 'scopes' });
    enc.clearBuffer(this.hist);
    enc.clearBuffer(this.wave);
    enc.clearBuffer(this.vect);
    enc.clearBuffer(this.stats);
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline());
    pass.setBindGroup(0, r.displayBindGroup(this.du, scene, null));
    pass.setBindGroup(
      1,
      d.createBindGroup({
        layout: this.scopeLayout,
        entries: [
          { binding: 0, resource: { buffer: this.su } },
          { binding: 1, resource: { buffer: this.hist } },
          { binding: 2, resource: { buffer: this.wave } },
          { binding: 3, resource: { buffer: this.vect } },
          { binding: 4, resource: { buffer: this.stats } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(gw / 16), Math.ceil(gh / 16));
    pass.end();
    d.queue.submit([enc.finish()]);
    this.lastStats = { samples: gw * gh };
  }

  /** Draws a scope into a canvas (size the canvas in device pixels beforehand). */
  draw(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    kind: ScopeKind,
    opts: {
      gain?: number;
      logScale?: boolean;
      channels?: { r: boolean; g: boolean; b: boolean; luma: boolean };
    } = {},
  ): void {
    const d = this.r.device;
    let v = this.views.get(canvas);
    if (!v) {
      const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!ctx) return;
      configureCanvas(ctx, d, { colorSpace: 'srgb', hdr: false });
      const ub = d.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bg = d.createBindGroup({
        layout: this.renderLayout,
        entries: [
          { binding: 0, resource: { buffer: ub } },
          { binding: 1, resource: { buffer: this.hist } },
          { binding: 2, resource: { buffer: this.wave } },
          { binding: 3, resource: { buffer: this.vect } },
          { binding: 4, resource: { buffer: this.stats } },
        ],
      });
      v = { ctx, ub, bg };
      this.views.set(canvas, v);
    }
    const k = { histogram: 0, waveform: 1, 'waveform-rgb': 2, parade: 3, vectorscope: 4 }[kind];
    const ch = opts.channels ?? { r: true, g: true, b: true, luma: false };
    const mask = (ch.r ? 1 : 0) | (ch.g ? 2 : 0) | (ch.b ? 4 : 0) | (ch.luma ? 8 : 0);
    d.queue.writeBuffer(
      v.ub,
      0,
      new Float32Array([
        canvas.width,
        canvas.height,
        opts.gain ?? 1,
        k,
        opts.logScale ? 1 : 0,
        mask,
        0,
        0,
      ]),
    );
    const enc = d.createCommandEncoder({ label: `scope:${kind}` });
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: v.ctx.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 1],
        },
      ],
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, v.bg);
    pass.draw(3);
    pass.end();
    d.queue.submit([enc.finish()]);
  }

  release(canvas: HTMLCanvasElement | OffscreenCanvas): void {
    const v = this.views.get(canvas);
    if (v) {
      v.ub.destroy();
      this.views.delete(canvas);
    }
  }

  /** Reads back the histogram (R,G,B,Y × 256) for numeric readouts / tests. */
  async readHistogram(): Promise<Uint32Array> {
    const d = this.r.device;
    const rb = d.createBuffer({
      size: 4 * 256 * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(this.hist, 0, rb, 0, 4 * 256 * 4);
    d.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(rb.getMappedRange().slice(0));
    rb.unmap();
    rb.destroy();
    return out;
  }
}
