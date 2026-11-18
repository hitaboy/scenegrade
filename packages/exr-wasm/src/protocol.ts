// SPDX-License-Identifier: Apache-2.0
// Messages exchanged between ExrWorkerPool and worker.ts.

import type { DecodedExr, ExrDecodeOptions, ExrInfo } from './types.ts';

export type WorkerRequest =
  | { kind: 'init'; wasmUrl?: string }
  | { kind: 'info'; id: number; bytes: ArrayBuffer | Uint8Array }
  | { kind: 'decode'; id: number; src: ArrayBuffer | Uint8Array | string; opts: ExrDecodeOptions }
  | { kind: 'abort'; id: number };

export interface SerializedError {
  name: string;
  message: string;
  code?: number;
}

export type WorkerResponse =
  | { id: number; ok: true; info: ExrInfo }
  | { id: number; ok: true; result: DecodedExr; fetchMs?: number }
  | { id: number; ok: false; error: SerializedError };
