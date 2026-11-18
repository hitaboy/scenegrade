/**
 * Shared WebGPU device. One device serves every player, viewer canvas and scope canvas on the page,
 * so textures can be shared between them without copies.
 */

export interface GpuCapabilities {
  float32Filterable: boolean;
  shaderF16: boolean;
  timestampQuery: boolean;
  maxTextureDimension2D: number;
  /** Browser + display can show values above SDR white on a WebGPU canvas. */
  hdrCanvas: boolean;
  adapterInfo: string;
}

export interface GpuContext {
  device: GPUDevice;
  adapter: GPUAdapter;
  caps: GpuCapabilities;
}

export class WebGpuUnavailableError extends Error {
  constructor(reason: string) {
    super(`WebGPU is not available: ${reason}`);
    this.name = 'WebGpuUnavailableError';
  }
}

let pending: Promise<GpuContext> | null = null;
const lostListeners = new Set<(info: GPUDeviceLostInfo) => void>();

export function isWebGpuSupported(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu;
}

/** Returns the shared GPU context, creating it on first call. */
export function getGpu(): Promise<GpuContext> {
  if (!pending) {
    pending = createContext().catch((e) => {
      pending = null;
      throw e;
    });
  }
  return pending;
}

/** Notified when the device is lost (driver reset, tab backgrounded on some platforms). */
export function onDeviceLost(fn: (info: GPUDeviceLostInfo) => void): () => void {
  lostListeners.add(fn);
  return () => lostListeners.delete(fn);
}

async function createContext(): Promise<GpuContext> {
  if (!isWebGpuSupported()) throw new WebGpuUnavailableError('navigator.gpu is missing');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new WebGpuUnavailableError('no suitable GPU adapter');

  const want: GPUFeatureName[] = ['float32-filterable', 'shader-f16', 'timestamp-query'];
  const requiredFeatures = want.filter((f) => adapter.features.has(f));
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });

  device.lost.then((info) => {
    pending = null;
    for (const fn of lostListeners) fn(info);
  });
  device.addEventListener('uncapturederror', (ev) => {
    console.error('[scenelinear] WebGPU error:', (ev as GPUUncapturedErrorEvent).error.message);
  });

  const info = adapter.info;
  const caps: GpuCapabilities = {
    float32Filterable: device.features.has('float32-filterable'),
    shaderF16: device.features.has('shader-f16'),
    timestampQuery: device.features.has('timestamp-query'),
    maxTextureDimension2D: device.limits.maxTextureDimension2D,
    hdrCanvas: detectHdrDisplay(),
    adapterInfo: info
      ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ')
      : '',
  };
  return { device, adapter, caps };
}

/** True when the current screen reports a high dynamic range (CSS `dynamic-range: high`). */
export function detectHdrDisplay(): boolean {
  try {
    return typeof matchMedia !== 'undefined' && matchMedia('(dynamic-range: high)').matches;
  } catch {
    return false;
  }
}

export const CANVAS_FORMAT: GPUTextureFormat = 'rgba16float';

/**
 * Configures a canvas for display. We always render to an rgba16float swap chain: no 8-bit banding,
 * and with `toneMapping: extended` values above 1.0 reach HDR displays.
 */
export function configureCanvas(
  ctx: GPUCanvasContext,
  device: GPUDevice,
  opts: { colorSpace: PredefinedColorSpace; hdr: boolean },
): void {
  const base: GPUCanvasConfiguration = {
    device,
    format: CANVAS_FORMAT,
    alphaMode: 'premultiplied',
    colorSpace: opts.colorSpace,
  };
  try {
    ctx.configure({ ...base, toneMapping: { mode: opts.hdr ? 'extended' : 'standard' } });
  } catch {
    ctx.configure(base);
  }
}
