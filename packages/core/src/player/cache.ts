import type { FrameData } from '../media/types.js';

/**
 * CPU frame cache with a byte budget. Eviction removes the frames *farthest from the playhead*
 * (respecting play direction) rather than least-recently-used, which is what you want for playback
 * and scrubbing.
 */
export class FrameCache {
  private frames = new Map<number, FrameData>();
  private bytes = 0;
  /** Bumped on every insert/delete; lets the UI redraw the cache bar cheaply. */
  version = 0;

  constructor(public budgetBytes: number) {}

  get size(): number {
    return this.frames.size;
  }

  get usedBytes(): number {
    return this.bytes;
  }

  has(i: number): boolean {
    return this.frames.has(i);
  }

  get(i: number): FrameData | undefined {
    return this.frames.get(i);
  }

  /** Returns false when the frame doesn't fit and is farther than everything cached. */
  put(f: FrameData, playhead: number, direction: 1 | -1, frameCount: number): boolean {
    if (this.frames.has(f.index)) {
      this.delete(f.index);
    }
    const dist = (i: number) => {
      let d = (i - playhead) * direction;
      if (d < 0) d += frameCount; // behind us: will only be needed after a loop
      return d;
    };
    while (this.bytes + f.bytes > this.budgetBytes && this.frames.size > 0) {
      let worst = -1;
      let worstD = -1;
      for (const i of this.frames.keys()) {
        const d = dist(i);
        if (d > worstD) {
          worstD = d;
          worst = i;
        }
      }
      if (worstD <= dist(f.index)) {
        f.release?.();
        return false;
      }
      this.delete(worst);
    }
    this.frames.set(f.index, f);
    this.bytes += f.bytes;
    this.version++;
    return true;
  }

  delete(i: number): void {
    const f = this.frames.get(i);
    if (!f) return;
    f.release?.();
    this.frames.delete(i);
    this.bytes -= f.bytes;
    this.version++;
  }

  clear(): void {
    for (const f of this.frames.values()) f.release?.();
    this.frames.clear();
    this.bytes = 0;
    this.version++;
  }

  /** Cached frame ranges as [start, end] inclusive pairs (for the timeline cache bar). */
  ranges(): [number, number][] {
    const keys = [...this.frames.keys()].sort((a, b) => a - b);
    const out: [number, number][] = [];
    for (const k of keys) {
      const last = out[out.length - 1];
      if (last && k === last[1] + 1) last[1] = k;
      else out.push([k, k]);
    }
    return out;
  }

  /** True if the next `n` frames from `from` are cached. */
  hasRun(from: number, n: number, frameCount: number, direction: 1 | -1): boolean {
    for (let k = 0; k < n; k++) {
      const i = (((from + k * direction) % frameCount) + frameCount) % frameCount;
      if (!this.frames.has(i)) return false;
    }
    return true;
  }
}
