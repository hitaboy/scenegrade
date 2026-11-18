/** Everything the user can change about how an image is displayed. Plain data, serialisable. */

export type ChannelMode = 'rgb' | 'r' | 'g' | 'b' | 'a' | 'luma';
export type BackgroundMode = 'black' | 'checker' | 'solid';
export type FalseColorMode = 'off' | 'stops' | 'ire';
export type CompareMode = 'off' | 'wipe' | 'side-by-side' | 'difference' | 'blend';
export type FilterMode = 'auto' | 'nearest' | 'linear';

export interface DisplaySettings {
  /** Input colour space id (color/INPUT_SPACES) – how the source pixels are encoded. */
  inputSpace: string;
  /** View id: a baked ACES view (color/VIEWS) or 'raw' | 'log-acescct' | 'srgb-clamp'. */
  view: string;
  /** Exposure in stops, applied in scene-linear. */
  exposure: number;
  /** Display gamma adjustment applied after the view transform (1 = none). */
  gamma: number;
  /** Scene saturation (1 = none). */
  saturation: number;
  channel: ChannelMode;
  background: BackgroundMode;
  /** Viewer background (outside the image), linear-ish display values. */
  backgroundColor: [number, number, number];
  falseColor: FalseColorMode;
  falseColorPreset: string;
  zebra: {
    high: boolean;
    low: boolean;
    highThreshold: number;
    lowThreshold: number;
    lowBand: number;
    stripeWidth: number;
  };
  clipping: { over: boolean; under: boolean; nan: boolean };
  peaking: { enabled: boolean; threshold: number; color: [number, number, number] };
  compare: { mode: CompareMode; wipe: number; angle: number; diffGain: number; blend: number };
  cdl: {
    enabled: boolean;
    slope: [number, number, number];
    offset: [number, number, number];
    power: [number, number, number];
    saturation: number;
  };
  userLut: { enabled: boolean; position: 'acescct' | 'display' };
  hdr: { enabled: boolean; referenceWhite: number };
  filter: FilterMode;
  displayWindowOutline: boolean;
}

export function defaultDisplaySettings(): DisplaySettings {
  return {
    inputSpace: 'acescg',
    view: 'srgb-aces2-sdr709',
    exposure: 0,
    gamma: 1,
    saturation: 1,
    channel: 'rgb',
    background: 'black',
    backgroundColor: [0.11, 0.11, 0.11],
    falseColor: 'off',
    falseColorPreset: 'arri-like',
    zebra: {
      high: false,
      low: false,
      highThreshold: 95,
      lowThreshold: 70,
      lowBand: 5,
      stripeWidth: 6,
    },
    clipping: { over: false, under: false, nan: false },
    peaking: { enabled: false, threshold: 0.12, color: [1, 0.15, 0.1] },
    compare: { mode: 'off', wipe: 0.5, angle: 0, diffGain: 4, blend: 0.5 },
    cdl: { enabled: false, slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 },
    userLut: { enabled: false, position: 'acescct' },
    hdr: { enabled: true, referenceWhite: 203 },
    filter: 'auto',
    displayWindowOutline: true,
  };
}

/** Viewport transform: canvas device pixel = image pixel * zoom + pan. */
export interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}
