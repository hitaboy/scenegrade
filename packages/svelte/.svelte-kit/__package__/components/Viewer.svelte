<script lang="ts">
  import { onMount } from 'svelte';
  import type { PlayerController } from '../controller.svelte.js';

  let { ctl }: { ctl: PlayerController } = $props();

  let canvas: HTMLCanvasElement;
  let wrap: HTMLDivElement;
  let size = $state({ w: 1, h: 1 });
  let dragging: { x: number; y: number; mode: 'pan' | 'wipe' } | null = null;
  let hover = $state<{ x: number; y: number } | null>(null);
  let probeBusy = false;

  onMount(() => {
    void ctl.player.attach(canvas);
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      size = { w: r.width, h: r.height };
      ctl.player.resize(r.width, r.height, devicePixelRatio || 1);
    });
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      ctl.player.detach(canvas);
    };
  });

  const dpr = () => ctl.player.canvasDevicePixelRatio;

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const anchor = { x: (e.clientX - r.left) * dpr(), y: (e.clientY - r.top) * dpr() };
    // Wheel / trackpad pinch (ctrl+wheel) zooms around the cursor; Shift+scroll pans.
    if (e.shiftKey) {
      ctl.player.panBy(-e.deltaX * dpr(), -e.deltaY * dpr());
      return;
    }
    ctl.player.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), anchor);
  }

  function wipeX(): number {
    const v = ctl.state.view;
    const m = ctl.state.media;
    if (!m) return 0;
    return (v.panX + ctl.settings.compare.wipe * m.width * (m.pixelAspectRatio || 1) * v.zoom) / dpr();
  }

  function onDown(e: PointerEvent) {
    if (e.button === 2) return;
    wrap.setPointerCapture(e.pointerId);
    const nearWipe = ctl.settings.compare.mode === 'wipe' && ctl.state.mediaB && Math.abs(e.offsetX - wipeX()) < 8;
    dragging = { x: e.clientX, y: e.clientY, mode: nearWipe ? 'wipe' : 'pan' };
    if (ctl.ui.tool === 'probe' && e.button === 0 && e.altKey) void pin(e);
  }

  function onMove(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    hover = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (dragging) {
      if (dragging.mode === 'pan') {
        ctl.player.panBy((e.clientX - dragging.x) * dpr(), (e.clientY - dragging.y) * dpr());
      } else {
        const m = ctl.state.media!;
        const v = ctl.state.view;
        const x = ((e.clientX - r.left) * dpr() - v.panX) / (v.zoom * (m.pixelAspectRatio || 1));
        ctl.update({ compare: { ...ctl.settings.compare, wipe: Math.min(1, Math.max(0, x / m.width)) } });
      }
      dragging.x = e.clientX;
      dragging.y = e.clientY;
    }
    if (ctl.ui.tool === 'probe') void doProbe(hover.x, hover.y);
  }

  async function doProbe(x: number, y: number) {
    if (probeBusy) return;
    probeBusy = true;
    try {
      ctl.probe = await ctl.player.probe(x * dpr(), y * dpr(), ctl.ui.probeRadius);
    } finally {
      probeBusy = false;
    }
  }

  async function pin(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    const p = await ctl.player.probe((e.clientX - r.left) * dpr(), (e.clientY - r.top) * dpr(), ctl.ui.probeRadius);
    if (p) ctl.probePinned = [...ctl.probePinned.slice(-7), p];
  }

  function onUp(e: PointerEvent) {
    dragging = null;
    wrap.releasePointerCapture(e.pointerId);
  }

  // Image rectangle in CSS pixels (for guides and masks).
  const rect = $derived.by(() => {
    const m = ctl.state?.media;
    const v = ctl.state?.view;
    if (!m || !v) return null;
    const d = ctl.player.canvasDevicePixelRatio;
    const pa = m.pixelAspectRatio || 1;
    return { x: v.panX / d, y: v.panY / d, w: (m.width * pa * v.zoom) / d, h: (m.height * v.zoom) / d };
  });

  const mask = $derived.by(() => {
    const r = rect;
    const a = ctl.ui.guides.mask;
    if (!r || !a) return null;
    const ia = r.w / r.h;
    if (a > ia) {
      const h = r.w / a;
      return { kind: 'h' as const, a: (r.h - h) / 2 };
    }
    const w = r.h * a;
    return { kind: 'v' as const, a: (r.w - w) / 2 };
  });

  const zoomLabel = $derived(ctl.state ? `${Math.round((ctl.state.view.zoom / ctl.player.canvasDevicePixelRatio) * 100)}%` : '');
</script>

<div
  class="viewer"
  bind:this={wrap}
  class:probe={ctl.ui.tool === 'probe'}
  role="img"
  aria-label={ctl.state?.media ? `Image viewer: ${ctl.state.media.name}` : 'Image viewer'}
  onwheel={onWheel}
  onpointerdown={onDown}
  onpointermove={onMove}
  onpointerup={onUp}
  onpointerleave={() => (hover = null)}
  ondblclick={() => ctl.player.fit()}
>
  <canvas bind:this={canvas}></canvas>

  {#if rect}
    <svg class="ov" width={size.w} height={size.h} aria-hidden="true">
      {#if mask}
        {#if mask.kind === 'h'}
          <rect x={rect.x} y={rect.y} width={rect.w} height={mask.a} class="mask" />
          <rect x={rect.x} y={rect.y + rect.h - mask.a} width={rect.w} height={mask.a} class="mask" />
        {:else}
          <rect x={rect.x} y={rect.y} width={mask.a} height={rect.h} class="mask" />
          <rect x={rect.x + rect.w - mask.a} y={rect.y} width={mask.a} height={rect.h} class="mask" />
        {/if}
      {/if}
      {#if ctl.ui.guides.safeAreas}
        <rect x={rect.x + rect.w * 0.035} y={rect.y + rect.h * 0.035} width={rect.w * 0.93} height={rect.h * 0.93} class="g" />
        <rect x={rect.x + rect.w * 0.05} y={rect.y + rect.h * 0.05} width={rect.w * 0.9} height={rect.h * 0.9} class="g dash" />
      {/if}
      {#if ctl.ui.guides.thirds}
        {#each [1, 2] as k (k)}
          <line x1={rect.x + (rect.w * k) / 3} x2={rect.x + (rect.w * k) / 3} y1={rect.y} y2={rect.y + rect.h} class="g" />
          <line y1={rect.y + (rect.h * k) / 3} y2={rect.y + (rect.h * k) / 3} x1={rect.x} x2={rect.x + rect.w} class="g" />
        {/each}
      {/if}
      {#if ctl.ui.guides.center}
        <line x1={rect.x + rect.w / 2 - 12} x2={rect.x + rect.w / 2 + 12} y1={rect.y + rect.h / 2} y2={rect.y + rect.h / 2} class="g" />
        <line y1={rect.y + rect.h / 2 - 12} y2={rect.y + rect.h / 2 + 12} x1={rect.x + rect.w / 2} x2={rect.x + rect.w / 2} class="g" />
      {/if}
      {#if ctl.settings.compare.mode === 'wipe' && ctl.state.mediaB}
        {@const x = wipeX()}
        <circle cx={x} cy={rect.y + rect.h / 2} r="7" class="handle" />
        <text x={x - 14} y={rect.y + 16} class="ab" text-anchor="end">A</text>
        <text x={x + 14} y={rect.y + 16} class="ab">B</text>
      {/if}
      {#each ctl.probePinned as p, i (i)}
        {@const d = ctl.player.canvasDevicePixelRatio}
        {@const v = ctl.state.view}
        <g transform="translate({(p.x * v.zoom + v.panX) / d}, {(p.y * v.zoom + v.panY) / d})">
          <circle r="5" class="pin" />
          <text x="8" y="-6" class="pinl">{i + 1}</text>
        </g>
      {/each}
    </svg>
  {/if}

  {#if ctl.state?.loading}
    <div class="msg">Loading…</div>
  {/if}
  <div class="zoom" aria-live="polite">{zoomLabel}</div>
</div>

<style>
  .viewer {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--sl-viewer-bg);
    cursor: grab;
    touch-action: none;
  }
  .viewer:active {
    cursor: grabbing;
  }
  .viewer.probe {
    cursor: crosshair;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .ov {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .g {
    fill: none;
    stroke: rgba(255, 255, 255, 0.45);
    stroke-width: 1;
  }
  .g.dash {
    stroke-dasharray: 4 4;
  }
  .mask {
    fill: rgba(0, 0, 0, 0.82);
  }
  .handle {
    fill: var(--sl-bg);
    stroke: #fff;
    stroke-width: 1.5;
  }
  .ab,
  .pinl {
    fill: #fff;
    font: 600 11px var(--sl-font);
    paint-order: stroke;
    stroke: rgba(0, 0, 0, 0.7);
    stroke-width: 3px;
  }
  .pin {
    fill: none;
    stroke: #fff;
    stroke-width: 1.5;
  }
  .msg {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--sl-text-muted);
    font-size: var(--sl-text-md);
    pointer-events: none;
  }
  .zoom {
    position: absolute;
    right: 8px;
    bottom: 6px;
    color: var(--sl-text-faint);
    font: var(--sl-text-xs) var(--sl-font-mono);
    pointer-events: none;
  }
</style>
