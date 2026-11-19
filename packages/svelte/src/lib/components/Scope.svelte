<script lang="ts">
  import { onMount } from 'svelte';
  import type { ScopeKind } from '@scenegrade/core';
  import type { PlayerController } from '../controller.svelte.js';

  let {
    ctl,
    kind,
    height = 150,
    gain = 1,
    logScale = false,
    channels = { r: true, g: true, b: true, luma: false },
  }: {
    ctl: PlayerController;
    kind: ScopeKind;
    height?: number;
    gain?: number;
    logScale?: boolean;
    channels?: { r: boolean; g: boolean; b: boolean; luma: boolean };
  } = $props();

  let canvas: HTMLCanvasElement;
  let box: HTMLDivElement;
  let w = $state(260);
  let h = $derived(kind === 'vectorscope' ? w : height);

  onMount(() => {
    const ro = new ResizeObserver(([e]) => {
      w = Math.max(80, Math.floor(e.contentRect.width));
    });
    ro.observe(box);
    return () => {
      ro.disconnect();
      ctl.player.detachScope(canvas);
    };
  });

  $effect(() => {
    const d = devicePixelRatio || 1;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    ctl.player.updateScope(canvas, kind, { gain, logScale, channels });
  });

  // Graticule helpers -----------------------------------------------------------------------
  const levels = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const range = $derived(ctl.player.scopeOptions.waveformRange);
  const yOf = (pct: number) => h - ((pct / 100 - range[0]) / (range[1] - range[0])) * h;

  const targets = $derived.by(() => {
    const T: [string, number, number, number][] = [
      ['R', 1, 0, 0],
      ['Mg', 1, 0, 1],
      ['B', 0, 0, 1],
      ['Cy', 0, 1, 1],
      ['G', 0, 1, 0],
      ['Yl', 1, 1, 0],
    ];
    return T.flatMap(([n, r, g, b]) =>
      [0.75, 1].map((amp) => {
        const R = r * amp,
          G = g * amp,
          B = b * amp;
        const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        const cb = (B - y) / 1.8556,
          cr = (R - y) / 1.5748;
        return { n, amp, x: (cb + 0.5) * w, y: (-cr + 0.5) * w };
      }),
    );
  });
  const stops = $derived(ctl.player.scopeOptions.stopsRange);
  const histMode = $derived(ctl.player.scopeOptions.histogramMode);
</script>

<div class="scope" bind:this={box} style:height="{h}px">
  <canvas bind:this={canvas} style:width="{w}px" style:height="{h}px" aria-label="{kind} scope"
  ></canvas>
  <svg width={w} height={h} aria-hidden="true">
    {#if kind === 'waveform' || kind === 'parade' || kind === 'waveform-rgb'}
      {#each levels as l (l)}
        <line x1="0" x2={w} y1={yOf(l)} y2={yOf(l)} class:major={l % 50 === 0} />
        {#if l % 20 === 0 || l === 100}<text x="3" y={yOf(l) - 2}>{l}</text>{/if}
      {/each}
      {#if kind === 'parade'}
        <line x1={w / 3} x2={w / 3} y1="0" y2={h} class="major" />
        <line x1={(2 * w) / 3} x2={(2 * w) / 3} y1="0" y2={h} class="major" />
      {/if}
    {:else if kind === 'vectorscope'}
      <circle cx={w / 2} cy={w / 2} r={w * 0.5 * 0.98} />
      <circle cx={w / 2} cy={w / 2} r={w * 0.25} class="faint" />
      <line x1={w / 2} x2={w / 2} y1="0" y2={w} class="faint" />
      <line y1={w / 2} y2={w / 2} x1="0" x2={w} class="faint" />
      <line
        x1={w / 2}
        y1={w / 2}
        x2={w / 2 - 0.545 * w * 0.48}
        y2={w / 2 - 0.839 * w * 0.48}
        class="skin"
      />
      {#each targets as t (t.n + t.amp)}
        <rect x={t.x - 4} y={t.y - 4} width="8" height="8" class:dim={t.amp < 1} />
        {#if t.amp === 1}<text x={t.x + 6} y={t.y + 3}>{t.n}</text>{/if}
      {/each}
    {:else if kind === 'histogram'}
      {#if histMode === 'stops'}
        {#each Array.from({ length: stops[1] - stops[0] + 1 }, (_, i) => stops[0] + i) as s (s)}
          {@const x = ((s - stops[0]) / (stops[1] - stops[0])) * w}
          <line x1={x} x2={x} y1="0" y2={h} class:major={s === 0} />
          {#if s % 2 === 0}<text x={x + 2} y="10">{s > 0 ? `+${s}` : s}</text>{/if}
        {/each}
      {:else}
        {#each [0, 25, 50, 75, 100] as p (p)}
          <line x1={(p / 100) * w} x2={(p / 100) * w} y1="0" y2={h} />
        {/each}
      {/if}
    {/if}
  </svg>
</div>

<style>
  .scope {
    position: relative;
    width: 100%;
    background: #000;
    border-radius: var(--sg-radius-sm);
    overflow: hidden;
  }
  canvas,
  svg {
    position: absolute;
    left: 0;
    top: 0;
    display: block;
  }
  svg line,
  svg circle,
  svg rect {
    fill: none;
    stroke: rgba(255, 255, 255, 0.14);
    stroke-width: 1;
  }
  svg .major {
    stroke: rgba(255, 255, 255, 0.28);
  }
  svg .faint {
    stroke: rgba(255, 255, 255, 0.08);
  }
  svg .skin {
    stroke: rgba(230, 180, 140, 0.45);
    stroke-dasharray: 3 3;
  }
  svg rect {
    stroke: rgba(255, 255, 255, 0.45);
  }
  svg rect.dim {
    stroke: rgba(255, 255, 255, 0.2);
  }
  svg text {
    fill: rgba(255, 255, 255, 0.45);
    font: 9px var(--sg-font-mono);
  }
</style>
