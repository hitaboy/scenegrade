// SPDX-License-Identifier: Apache-2.0
//
// Web Worker entry: owns one wasm decoder instance. Created by ExrWorkerPool with
//   new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

import { createExrDecoder } from './decoder.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';
import type { ExrDecoder } from './types.ts';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
}
// `self` (not globalThis) so that simulated workers (e.g. @vitest/web-worker) work too
const scope = self as unknown as WorkerScope;

let wasmUrl: string | undefined;
let decoderPromise: Promise<ExrDecoder> | null = null;
const fetches = new Map<number, AbortController>();
const aborted = new Set<number>();

function decoder(): Promise<ExrDecoder> {
  if (!decoderPromise) {
    decoderPromise = createExrDecoder(wasmUrl ? { wasmUrl } : {});
    decoderPromise.catch(() => (decoderPromise = null));
  }
  return decoderPromise;
}

function toBytes(src: ArrayBuffer | Uint8Array): Uint8Array {
  return src instanceof Uint8Array ? src : new Uint8Array(src);
}

function fail(id: number, e: unknown) {
  const err = e as { name?: string; message?: string; code?: number };
  scope.postMessage({
    id,
    ok: false,
    error: { name: err?.name ?? 'Error', message: err?.message ?? String(e), code: err?.code },
  });
}

async function handle(msg: WorkerRequest) {
  switch (msg.kind) {
    case 'init':
      wasmUrl = msg.wasmUrl;
      return;
    case 'abort':
      aborted.add(msg.id);
      fetches.get(msg.id)?.abort();
      return;
    case 'info': {
      try {
        const d = await decoder();
        scope.postMessage({ id: msg.id, ok: true, info: d.readInfo(toBytes(msg.bytes)) });
      } catch (e) {
        fail(msg.id, e);
      }
      return;
    }
    case 'decode': {
      const { id } = msg;
      try {
        let bytes: Uint8Array;
        let fetchMs: number | undefined;
        if (typeof msg.src === 'string') {
          const ac = new AbortController();
          fetches.set(id, ac);
          const t0 = performance.now();
          try {
            const res = await fetch(msg.src, { signal: ac.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${msg.src}`);
            bytes = new Uint8Array(await res.arrayBuffer());
          } finally {
            fetches.delete(id);
          }
          fetchMs = performance.now() - t0;
        } else {
          bytes = toBytes(msg.src);
        }
        const d = await decoder();
        if (aborted.has(id)) {
          aborted.delete(id);
          fail(id, { name: 'AbortError', message: 'aborted' });
          return;
        }
        const result = d.decode(bytes, msg.opts);
        // transfer, never copy, the pixel buffer
        scope.postMessage({ id, ok: true, result, fetchMs }, [result.pixels.buffer as ArrayBuffer]);
      } catch (e) {
        fail(id, e);
      } finally {
        aborted.delete(id);
      }
      return;
    }
  }
}

scope.onmessage = (ev) => {
  void handle(ev.data);
};
