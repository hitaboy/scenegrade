/** GPU passes we time with timestamp queries. */
export type GpuPass = 'decode' | 'display' | 'scopes';

const SLOTS = 8;
/** `resolveQuerySet` destination offsets must be multiples of 256. */
const STRIDE = 256;

/** One timed pass: put `timestampWrites` on the pass, `resolve` after `pass.end()`, `submitted` after submit. */
export interface GpuMeasure {
  timestampWrites: GPURenderPassTimestampWrites & GPUComputePassTimestampWrites;
  resolve(enc: GPUCommandEncoder): void;
  submitted(): void;
}

/**
 * GPU time per pass from `timestamp-query`, read back asynchronously (never stalls a frame: when every
 * readback buffer is still mapped, that frame is simply not timed). Values are smoothed (EMA, ms).
 * Browsers quantise timestamps (Chrome: 100 µs), so single passes are approximate.
 */
export class GpuTimer {
  readonly ms: Record<GpuPass, number> = { decode: 0, display: 0, scopes: 0 };
  /** Called after each new measurement (from a promise callback). */
  onUpdate: (() => void) | null = null;
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuf: GPUBuffer;
  private readonly readback: GPUBuffer[] = [];
  private readonly busy: boolean[] = [];
  private next = 0;

  private constructor(private readonly device: GPUDevice) {
    this.querySet = device.createQuerySet({ type: 'timestamp', count: SLOTS * 2 });
    this.resolveBuf = device.createBuffer({
      label: 'timestamps',
      size: SLOTS * STRIDE,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
  }

  /** Null when the device lacks `timestamp-query`. */
  static create(device: GPUDevice): GpuTimer | null {
    return device.features.has('timestamp-query') ? new GpuTimer(device) : null;
  }

  /** Sum of the smoothed pass times of one displayed frame. */
  get totalMs(): number {
    return this.ms.decode + this.ms.display + this.ms.scopes;
  }

  measure(pass: GpuPass): GpuMeasure | null {
    let slot = -1;
    for (let i = 0; i < SLOTS; i++) {
      const s = (this.next + i) % SLOTS;
      if (!this.busy[s]) {
        slot = s;
        break;
      }
    }
    if (slot < 0) return null;
    this.next = (slot + 1) % SLOTS;
    this.busy[slot] = true;
    const rb = (this.readback[slot] ??= this.device.createBuffer({
      label: `timestamps-readback-${slot}`,
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    }));
    return {
      timestampWrites: {
        querySet: this.querySet,
        beginningOfPassWriteIndex: slot * 2,
        endOfPassWriteIndex: slot * 2 + 1,
      },
      resolve: (enc) => {
        enc.resolveQuerySet(this.querySet, slot * 2, 2, this.resolveBuf, slot * STRIDE);
        enc.copyBufferToBuffer(this.resolveBuf, slot * STRIDE, rb, 0, 16);
      },
      submitted: () => {
        rb.mapAsync(GPUMapMode.READ).then(
          () => {
            const t = new BigUint64Array(rb.getMappedRange());
            const ns = Number(t[1] - t[0]);
            rb.unmap();
            this.busy[slot] = false;
            // Ignore wrapped / reset counters.
            if (ns >= 0 && ns < 1e9) {
              const ms = ns / 1e6;
              this.ms[pass] = this.ms[pass] ? this.ms[pass] * 0.8 + ms * 0.2 : ms;
              this.onUpdate?.();
            }
          },
          () => {
            this.busy[slot] = false;
          },
        );
      },
    };
  }

  dispose(): void {
    this.querySet.destroy();
    this.resolveBuf.destroy();
    for (const b of this.readback) b?.destroy();
  }
}
