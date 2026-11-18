<script lang="ts" module>
  /** 16px line icons, 1.5px stroke, drawn on a 16×16 grid. */
  export const ICONS: Record<string, string> = {
    play: '<path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M5 3.5v9M11 3.5v9" stroke-width="2"/>',
    'step-back': '<path d="M4 3.5v9M12 3.5v9L6 8z"/>',
    'step-fwd': '<path d="M12 3.5v9M4 3.5v9L10 8z"/>',
    'to-start': '<path d="M3.5 3.5v9M13 3.5v9L6.5 8zM9 3.5"/>',
    'to-end': '<path d="M12.5 3.5v9M3 3.5v9L9.5 8z"/>',
    'play-back': '<path d="M11 3.5v9L4 8z" fill="currentColor" stroke="none"/>',
    loop: '<path d="M3 7V6a2 2 0 0 1 2-2h7l-2-2M13 9v1a2 2 0 0 1-2 2H4l2 2"/>',
    once: '<path d="M3 8h9M9 5l3 3-3 3M13.5 4v8"/>',
    pingpong: '<path d="M2.5 6h11l-2.5-2.5M13.5 10h-11L5 12.5"/>',
    volume: '<path d="M3 6.5v3h2.5L9 12.5v-9L5.5 6.5zM11.5 5.5a3.5 3.5 0 0 1 0 5"/>',
    mute: '<path d="M3 6.5v3h2.5L9 12.5v-9L5.5 6.5zM11 6l3 4M14 6l-3 4"/>',
    fullscreen: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
    probe: '<circle cx="8" cy="8" r="4.5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/>',
    falsecolor: '<rect x="2" y="3" width="3" height="10" fill="currentColor" stroke="none" opacity=".35"/><rect x="6.5" y="3" width="3" height="10" fill="currentColor" stroke="none" opacity=".65"/><rect x="11" y="3" width="3" height="10" fill="currentColor" stroke="none"/>',
    zebra: '<path d="M2 10l8-8M2 14L14 2M6 14l8-8"/><rect x="2" y="2" width="12" height="12" rx="1"/>',
    clip: '<path d="M8 2.5l6 11H2z"/><path d="M8 6.5v3.5M8 11.5v.5"/>',
    peaking: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/>',
    compare: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M8 1.5v13"/>',
    guides: '<rect x="2" y="3" width="12" height="10" rx="1"/><rect x="4" y="5" width="8" height="6" stroke-dasharray="1.5 1.5"/>',
    checker: '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M2 8h12M8 2v12" /><rect x="2" y="2" width="6" height="6" fill="currentColor" stroke="none" opacity=".5"/><rect x="8" y="8" width="6" height="6" fill="currentColor" stroke="none" opacity=".5"/>',
    fit: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/><rect x="5.5" y="5.5" width="5" height="5"/>',
    one: '<path d="M5 5l2-1.5v9M10.5 6.5v.5M10.5 10.5v.5"/>',
    panel: '<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M10 2.5v11"/>',
    info: '<circle cx="8" cy="8" r="6"/><path d="M8 7v4.5M8 4.8v.4"/>',
    scopes: '<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M3.5 11l2.5-4 2 2.5 2.5-5 2 3.5"/>',
    sliders: '<path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.3" fill="currentColor"/><circle cx="10.5" cy="8" r="1.3" fill="currentColor"/><circle cx="5" cy="12" r="1.3" fill="currentColor"/>',
    open: '<path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H7.5L6 3.5H3a1 1 0 0 0-1 1z"/>',
    camera: '<rect x="2" y="4.5" width="12" height="8.5" rx="1"/><circle cx="8" cy="8.8" r="2.3"/><path d="M5.5 4.5L6.5 3h3l1 1.5"/>',
    keyboard: '<rect x="1.5" y="4" width="13" height="8" rx="1"/><path d="M4 6.5h.5M6.5 6.5H7M9 6.5h.5M11.5 6.5h.5M4.5 9.5h7"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
    chevron: '<path d="M4.5 6.5L8 10l3.5-3.5"/>',
    in: '<path d="M5 3v10M5 8h7M9 5l3 3-3 3"/>',
    out: '<path d="M11 3v10M11 8H4M7 5L4 8l3 3"/>',
    hdr: '<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 6v4M6.5 6v4M4 8h2.5M8.5 6v4h1a2 2 0 0 0 0-4zM12 10V6"/>',
    pin: '<path d="M6 2.5h4l-.5 4 2 2v1H4.5v-1l2-2zM8 9.5v4"/>',
    reset: '<path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2M3.5 2.5v2.3h2.3"/>',
  };
</script>

<script lang="ts">
  let { name, size = 16, title = '' }: { name: string; size?: number; title?: string } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={title ? undefined : 'true'}
  role={title ? 'img' : undefined}
>
  {#if title}<title>{title}</title>{/if}
  {@html ICONS[name] ?? ''}
</svg>

<style>
  svg {
    display: block;
    flex: none;
  }
</style>
