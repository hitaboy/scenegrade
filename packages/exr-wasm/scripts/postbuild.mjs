// SPDX-License-Identifier: Apache-2.0
// After `tsc`, point the worker URL at the compiled file. tsc rewrites import
// specifiers (.ts -> .js) but not `new URL('./worker.ts', import.meta.url)`.
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../dist/pool.js', import.meta.url);
const src = readFileSync(file, 'utf8');
const out = src.replace(
  "new URL('./worker.ts', import.meta.url)",
  "new URL('./worker.js', import.meta.url)",
);
if (out === src) throw new Error('postbuild: worker URL not found in dist/pool.js');
writeFileSync(file, out);
console.log('postbuild: dist/pool.js -> ./worker.js');
