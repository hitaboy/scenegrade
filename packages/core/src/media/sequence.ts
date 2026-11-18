/** Frame-sequence helpers: detect `shot.1001.exr` style sequences and expand `####` / `%04d` patterns. */

export type ItemSource = File | Blob | string;

export interface SequenceItem {
  name: string;
  frame: number;
  src: ItemSource;
}

export interface Sequence {
  name: string;
  /** Pattern for display, e.g. `shot.####.exr`. */
  pattern: string;
  first: number;
  last: number;
  items: SequenceItem[];
  /** Frame numbers missing inside [first, last]. */
  missing: number[];
}

const FRAME_RE = /^(.*?)(\d+)(\.[A-Za-z0-9]+)$/;

export function splitFrameNumber(
  name: string,
): { prefix: string; digits: string; ext: string } | null {
  const m = FRAME_RE.exec(name);
  if (!m) return null;
  return { prefix: m[1], digits: m[2], ext: m[3] };
}

/**
 * Groups files into sequences. Files that don't look like frames become single-item sequences.
 * Returns the groups sorted by size (largest first).
 */
export function detectSequences(files: { name: string; src: ItemSource }[]): Sequence[] {
  const groups = new Map<string, SequenceItem[]>();
  const singles: Sequence[] = [];
  for (const f of files) {
    const base = f.name.split('/').pop()!;
    const s = splitFrameNumber(base);
    if (!s) {
      singles.push({
        name: base,
        pattern: base,
        first: 0,
        last: 0,
        items: [{ name: base, frame: 0, src: f.src }],
        missing: [],
      });
      continue;
    }
    const key = `${s.prefix}\u0000${s.ext.toLowerCase()}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push({ name: base, frame: parseInt(s.digits, 10), src: f.src });
  }
  const seqs: Sequence[] = [];
  for (const [key, items] of groups) {
    items.sort((a, b) => a.frame - b.frame);
    const [prefix, ext] = key.split('\u0000');
    const pad = splitFrameNumber(items[0].name)!.digits.length;
    const first = items[0].frame;
    const last = items[items.length - 1].frame;
    const have = new Set(items.map((i) => i.frame));
    const missing: number[] = [];
    for (let n = first; n <= last && missing.length < 10000; n++) if (!have.has(n)) missing.push(n);
    const name = prefix.replace(/[._-]$/, '') || items[0].name;
    seqs.push({ name, pattern: `${prefix}${'#'.repeat(pad)}${ext}`, first, last, items, missing });
  }
  return [...seqs, ...singles].sort((a, b) => b.items.length - a.items.length);
}

/** True when a URL contains a frame placeholder (`####`, `%04d`, `$F4`). */
export function isSequencePattern(url: string): boolean {
  return /#+|%0?\d*d|\$F\d?/.test(url);
}

/** Expands `shot.####.exr` / `shot.%04d.exr` / `shot.$F4.exr` for frames first..last. */
export function expandPattern(url: string, first: number, last: number): SequenceItem[] {
  const items: SequenceItem[] = [];
  const fmt = (n: number): string =>
    url
      .replace(/#+/, (m) => String(n).padStart(m.length, '0'))
      .replace(/%0?(\d*)d/, (_m, w) => String(n).padStart(parseInt(w || '1', 10), '0'))
      .replace(/\$F(\d?)/, (_m, w) => String(n).padStart(parseInt(w || '1', 10), '0'));
  for (let n = first; n <= last; n++) {
    const u = fmt(n);
    items.push({ name: u.split('/').pop()!.split('?')[0], frame: n, src: u });
  }
  return items;
}

export function extensionOf(name: string): string {
  const clean = name.split('?')[0].split('#')[0];
  const i = clean.lastIndexOf('.');
  return i >= 0 ? clean.slice(i + 1).toLowerCase() : '';
}

export async function readBytes(src: ItemSource, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (typeof src === 'string') {
    const res = await fetch(src, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${src}`);
    return res.arrayBuffer();
  }
  return src.arrayBuffer();
}
