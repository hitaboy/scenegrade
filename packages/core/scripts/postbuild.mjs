// Copies the baked ACES view LUTs next to the compiled colour module (dist/color/luts).
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(`${root}dist/color/luts`, { recursive: true });
cpSync(`${root}src/color/luts`, `${root}dist/color/luts`, { recursive: true });
console.log('copied LUTs to dist/color/luts');
