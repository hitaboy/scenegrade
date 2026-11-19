import type { AudioSource } from '../media/types.js';

/**
 * Plays a source's audio through WebAudio and acts as the master clock while it runs.
 * Only used for forward playback at 1×; otherwise the player runs on its own clock, muted.
 */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nodes = new Set<AudioBufferSourceNode>();
  private run = 0;
  private ctxStart = 0;
  private mediaStart = 0;
  private _volume = 1;
  private _muted = false;
  active = false;

  set volume(v: number) {
    this._volume = v;
    this.applyGain();
  }
  get volume(): number {
    return this._volume;
  }
  set muted(m: boolean) {
    this._muted = m;
    this.applyGain();
  }
  get muted(): boolean {
    return this._muted;
  }

  private applyGain(): void {
    if (this.gain) this.gain.gain.value = this._muted ? 0 : this._volume;
  }

  /** Current media time (seconds) according to the audio hardware clock. */
  get mediaTime(): number {
    if (!this.ctx || !this.active) return NaN;
    return this.mediaStart + (this.ctx.currentTime - this.ctxStart);
  }

  async start(src: AudioSource, mediaTime: number): Promise<void> {
    this.stop();
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.applyGain();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const run = ++this.run;
    const ctx = this.ctx;
    this.ctxStart = ctx.currentTime + 0.08;
    this.mediaStart = mediaTime;
    this.active = true;
    void (async () => {
      try {
        for await (const b of src.buffers(mediaTime)) {
          if (run !== this.run) break;
          const at = this.ctxStart + (b.timestamp - this.mediaStart);
          const node = ctx.createBufferSource();
          node.buffer = b.buffer;
          node.connect(this.gain!);
          if (at >= ctx.currentTime) node.start(at);
          else {
            const offset = ctx.currentTime - at;
            if (offset < b.duration) node.start(ctx.currentTime, offset);
          }
          this.nodes.add(node);
          node.onended = () => this.nodes.delete(node);
          // Stay ~1.5 s ahead of the playhead.
          while (run === this.run && at - ctx.currentTime > 1.5)
            await new Promise((r) => setTimeout(r, 100));
        }
      } catch (e) {
        if (run === this.run) console.warn('[scenegrade] audio stopped:', e);
      }
    })();
  }

  stop(): void {
    this.run++;
    this.active = false;
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* not started */
      }
    }
    this.nodes.clear();
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
