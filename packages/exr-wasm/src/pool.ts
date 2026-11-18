// SPDX-License-Identifier: Apache-2.0
//
// Pool of Web Workers, each owning one wasm decoder. Jobs are queued by priority
// (higher first, FIFO within the same priority) and dispatched to idle workers.
// Pixel buffers are transferred back from the workers, never copied.

import type { WorkerRequest, WorkerResponse } from './protocol.ts';
import {
  ExrError,
  ExrUnsupportedError,
  type DecodedExr,
  type ExrDecodeOptions,
  type ExrInfo,
} from './types.ts';

export interface ExrWorkerPoolOptions {
  /** Number of workers. Default: max(1, hardwareConcurrency - 2), capped at 8. */
  size?: number;
  /** URL of openexr.wasm (default: the copy shipped with this package). */
  wasmUrl?: string | URL;
}

export interface ExrPoolDecodeOptions extends ExrDecodeOptions {
  signal?: AbortSignal;
  /** Higher runs first. Default 0. */
  priority?: number;
  /**
   * Transfer (detach) the caller's ArrayBuffer to the worker instead of copying it.
   * Only applies when `src` is an ArrayBuffer or a Uint8Array spanning its whole buffer.
   */
  transferInput?: boolean;
}

interface Job {
  id: number;
  priority: number;
  seq: number;
  msg: WorkerRequest;
  transfer: Transferable[];
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

interface Slot {
  worker: Worker;
  job: Job | null;
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function hardwareConcurrency(): number {
  const n = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
    ?.hardwareConcurrency;
  return typeof n === 'number' && n > 0 ? n : 4;
}

function resolveUrl(u: string | URL): string {
  const base = (globalThis as { location?: { href: string } }).location?.href;
  try {
    return new URL(String(u), base).href;
  } catch {
    return String(u);
  }
}

export class ExrWorkerPool {
  readonly size: number;
  #wasmUrl: string | undefined;
  #slots: Slot[] = [];
  #queue: Job[] = [];
  #nextId = 1;
  #seq = 0;
  #disposed = false;

  constructor(opts: ExrWorkerPoolOptions = {}) {
    const def = Math.min(8, Math.max(1, hardwareConcurrency() - 2));
    this.size = Math.max(1, Math.floor(opts.size ?? def));
    this.#wasmUrl = opts.wasmUrl !== undefined ? resolveUrl(opts.wasmUrl) : undefined;
  }

  /** Number of jobs waiting for a worker. */
  get pending(): number {
    return this.#queue.length;
  }

  readInfo(bytes: ArrayBuffer | Uint8Array): Promise<ExrInfo> {
    return this.#enqueue<ExrInfo>((id) => ({ kind: 'info', id, bytes }), [], 0);
  }

  decode(
    src: ArrayBuffer | Uint8Array | string,
    o: ExrPoolDecodeOptions = {},
  ): Promise<DecodedExr> {
    const { signal, priority = 0, transferInput = false, ...opts } = o;
    let payload: ArrayBuffer | Uint8Array | string = src;
    const transfer: Transferable[] = [];
    if (typeof src === 'string') {
      payload = resolveUrl(src); // relative URLs resolve against the document, not the worker
    } else if (transferInput) {
      const buf = src instanceof Uint8Array ? src.buffer : src;
      if (
        buf instanceof ArrayBuffer &&
        (!(src instanceof Uint8Array) ||
          (src.byteOffset === 0 && src.byteLength === buf.byteLength))
      )
        transfer.push(buf);
    }
    return this.#enqueue<DecodedExr>(
      (id) => ({ kind: 'decode', id, src: payload, opts }),
      transfer,
      priority,
      signal,
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const s of this.#slots) {
      s.worker.terminate();
      if (s.job) this.#settle(s.job, false, new ExrError('worker pool disposed'));
    }
    for (const j of this.#queue) this.#settle(j, false, new ExrError('worker pool disposed'));
    this.#slots = [];
    this.#queue = [];
  }

  // ----------------------------------------------------------------------- internals

  #enqueue<T>(
    make: (id: number) => WorkerRequest,
    transfer: Transferable[],
    priority: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.#disposed) return Promise.reject(new ExrError('worker pool disposed'));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        id,
        priority,
        seq: this.#seq++,
        msg: make(id),
        transfer,
        resolve: resolve as (v: unknown) => void,
        reject,
        settled: false,
      };
      if (signal) {
        job.signal = signal;
        job.onAbort = () => this.#abort(job);
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      // insert keeping (priority desc, seq asc)
      let i = this.#queue.length;
      while (i > 0 && this.#queue[i - 1].priority < priority) i--;
      this.#queue.splice(i, 0, job);
      this.#pump();
    });
  }

  #settle(job: Job, ok: boolean, value: unknown) {
    if (job.settled) return;
    job.settled = true;
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    if (ok) job.resolve(value);
    else job.reject(value);
  }

  #abort(job: Job) {
    const qi = this.#queue.indexOf(job);
    if (qi >= 0) this.#queue.splice(qi, 1);
    else {
      // running: tell the worker (cancels an in-flight fetch); the result is ignored
      const slot = this.#slots.find((s) => s.job === job);
      slot?.worker.postMessage({ kind: 'abort', id: job.id } satisfies WorkerRequest);
    }
    this.#settle(job, false, abortError());
  }

  #spawn(): Slot {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'exr-decoder',
    });
    const slot: Slot = { worker, job: null };
    worker.postMessage({ kind: 'init', wasmUrl: this.#wasmUrl } satisfies WorkerRequest);
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.#onMessage(slot, ev.data);
    worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault?.();
      const job = slot.job;
      slot.job = null;
      worker.terminate();
      this.#slots = this.#slots.filter((s) => s !== slot);
      if (job)
        this.#settle(job, false, new ExrError(`worker error: ${ev.message || 'failed to start'}`));
      this.#pump();
    };
    this.#slots.push(slot);
    return slot;
  }

  #onMessage(slot: Slot, msg: WorkerResponse) {
    const job = slot.job;
    if (!job || job.id !== msg.id) return;
    slot.job = null;
    if (msg.ok) {
      this.#settle(job, true, 'info' in msg ? msg.info : msg.result);
    } else {
      const { name, message, code } = msg.error;
      let err: Error;
      if (name === 'AbortError') err = abortError();
      else if (name === 'ExrUnsupportedError') err = new ExrUnsupportedError(message, code);
      else err = new ExrError(message, code);
      this.#settle(job, false, err);
    }
    this.#pump();
  }

  #pump() {
    if (this.#disposed) return;
    while (this.#queue.length) {
      let slot = this.#slots.find((s) => !s.job);
      if (!slot) {
        if (this.#slots.length >= this.size) return;
        slot = this.#spawn();
      }
      const job = this.#queue.shift()!;
      slot.job = job;
      slot.worker.postMessage(job.msg, job.transfer);
    }
  }
}
