import type { FrameSource } from './types.js';
import {
  detectSequences,
  expandPattern,
  extensionOf,
  isSequencePattern,
  type SequenceItem,
} from './sequence.js';
import { ExrSource } from './exr-source.js';
import { VideoSource } from './video-source.js';
import { BrowserImageSource } from './image-source.js';

export const VIDEO_EXTENSIONS = ['mov', 'mp4', 'm4v', 'mkv', 'webm', 'mxf'];
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif'];
export const EXR_EXTENSIONS = ['exr'];

/** What can be loaded: a URL, a `####` pattern URL, a File, several Files (a sequence) or a directory. */
export type MediaInput =
  | string
  | File
  | Blob
  | File[]
  | FileList
  | { url: string; first: number; last: number }
  | { directory: FileSystemDirectoryHandle };

export interface OpenOptions {
  fps?: number;
  /** Colour space assumed for EXRs without chromaticities. */
  exrDefaultSpace?: string;
  signal?: AbortSignal;
}

async function filesFromDirectory(dir: FileSystemDirectoryHandle): Promise<File[]> {
  const files: File[] = [];
  for await (const entry of (
    dir as unknown as { values(): AsyncIterable<FileSystemHandle> }
  ).values()) {
    if (entry.kind === 'file') files.push(await (entry as FileSystemFileHandle).getFile());
  }
  return files;
}

function openItems(items: SequenceItem[], name: string, o: OpenOptions): Promise<FrameSource> {
  const ext = extensionOf(items[0].name);
  if (EXR_EXTENSIONS.includes(ext))
    return ExrSource.open(items, {
      name,
      fps: o.fps,
      defaultSpace: o.exrDefaultSpace,
      signal: o.signal,
    });
  if (items.length === 1) {
    if (VIDEO_EXTENSIONS.includes(ext))
      return VideoSource.open(items[0].src, { name, signal: o.signal });
    if (IMAGE_EXTENSIONS.includes(ext))
      return BrowserImageSource.open(items[0].src, { name, signal: o.signal });
  }
  throw new Error(`Unsupported file type: .${ext}`);
}

export async function openMedia(input: MediaInput, o: OpenOptions = {}): Promise<FrameSource> {
  if (typeof input === 'string') {
    if (isSequencePattern(input))
      throw new Error('A frame pattern URL needs a range: pass { url, first, last }');
    const name = decodeURIComponent(input.split('/').pop()!.split('?')[0]);
    return openItems([{ name, frame: 0, src: input }], name, o);
  }
  if ('url' in input && 'first' in input) {
    const items = expandPattern(input.url, input.first, input.last);
    return openItems(items, input.url.split('/').pop()!, o);
  }
  if ('directory' in input) return openMedia(await filesFromDirectory(input.directory), o);
  if (input instanceof Blob) {
    const name = input instanceof File ? input.name : 'blob';
    const ext = extensionOf(name);
    if (!ext && input.type.startsWith('video/'))
      return VideoSource.open(input, { name, signal: o.signal });
    return openItems([{ name, frame: 0, src: input }], name, o);
  }
  const files = Array.from(input as ArrayLike<File>);
  if (files.length === 0) throw new Error('No files');
  if (files.length === 1) return openMedia(files[0], o);
  const seqs = detectSequences(files.map((f) => ({ name: f.name, src: f })));
  const s = seqs[0];
  return openItems(s.items, s.items.length > 1 ? s.pattern : s.name, o);
}
