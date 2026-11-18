<script lang="ts">
  import type { PlayerController } from '../controller.svelte.js';
  let { ctl }: { ctl: PlayerController } = $props();

  let el: HTMLDivElement;
  let hoverFrac = $state<number | null>(null);
  const n = $derived(ctl.state.media?.frameCount ?? 1);
  const first = $derived(ctl.state.media?.firstFrame ?? 0);
  const pos = (i: number) => (n <= 1 ? 0 : i / (n - 1));

  // Cache bar ranges, recomputed when the cache changes.
  const ranges = $derived.by(() => {
    void ctl.state.cacheVersion;
    return ctl.player.cachedRanges();
  });

  function frameAt(clientX: number): number {
    const r = el.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * (n - 1));
  }
  function down(e: PointerEvent) {
    el.setPointerCapture(e.pointerId);
    ctl.player.pause();
    ctl.player.seek(frameAt(e.clientX));
  }
  function move(e: PointerEvent) {
    const r = el.getBoundingClientRect();
    hoverFrac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (el.hasPointerCapture(e.pointerId)) ctl.player.seek(frameAt(e.clientX));
  }
  function key(e: KeyboardEvent) {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowRight') ctl.player.step(step);
    else if (e.key === 'ArrowLeft') ctl.player.step(-step);
    else if (e.key === 'Home') ctl.player.seek(ctl.state.inPoint);
    else if (e.key === 'End') ctl.player.seek(ctl.state.outPoint);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  const ticks = $derived.by(() => {
    const count = Math.min(12, n);
    return Array.from({ length: count }, (_, k) => Math.round((k / Math.max(1, count - 1)) * (n - 1)));
  });
</script>

<div
  class="tl"
  bind:this={el}
  role="slider"
  tabindex="0"
  aria-label="Timeline"
  aria-valuemin={first}
  aria-valuemax={first + n - 1}
  aria-valuenow={first + ctl.state.frame}
  onpointerdown={down}
  onpointermove={move}
  onpointerleave={() => (hoverFrac = null)}
  onkeydown={key}
>
  <div class="inout" style:left="{pos(ctl.state.inPoint) * 100}%" style:width="{(pos(ctl.state.outPoint) - pos(ctl.state.inPoint)) * 100}%"></div>
  <div class="track"></div>
  <div class="cache" aria-hidden="true">
    {#each ranges as [a, b] (a)}
      <span style:left="{(a / n) * 100}%" style:width="{((b - a + 1) / n) * 100}%"></span>
    {/each}
  </div>
  {#each ticks as t (t)}
    <span class="tick" style:left="{pos(t) * 100}%"><i>{first + t}</i></span>
  {/each}
  {#if hoverFrac != null}
    <span class="hover" style:left="{hoverFrac * 100}%"><i>{first + Math.round(hoverFrac * (n - 1))}</i></span>
  {/if}
  <div class="head" style:left="{pos(ctl.state.frame) * 100}%"></div>
</div>

<style>
  .tl {
    position: relative;
    flex: 1;
    height: 30px;
    cursor: pointer;
    touch-action: none;
  }
  .tl:focus-visible {
    outline: none;
    box-shadow: var(--sl-focus);
    border-radius: var(--sl-radius-sm);
  }
  .track {
    position: absolute;
    left: 0;
    right: 0;
    top: 10px;
    height: 6px;
    border-radius: 2px;
    background: var(--sl-surface-3);
  }
  .inout {
    position: absolute;
    top: 6px;
    height: 14px;
    background: var(--sl-inout);
    border-left: 1px solid var(--sl-accent);
    border-right: 1px solid var(--sl-accent);
  }
  .cache {
    position: absolute;
    left: 0;
    right: 0;
    top: 18px;
    height: 2px;
  }
  .cache span {
    position: absolute;
    top: 0;
    height: 2px;
    background: var(--sl-cache);
  }
  .tick {
    position: absolute;
    top: 20px;
    width: 1px;
    height: 4px;
    background: var(--sl-border-strong);
  }
  .tick i,
  .hover i {
    position: absolute;
    top: 3px;
    transform: translateX(-50%);
    color: var(--sl-text-faint);
    font: normal 9px var(--sl-font-mono);
    white-space: nowrap;
  }
  .tick:first-of-type i {
    transform: none;
  }
  .hover {
    position: absolute;
    top: 4px;
    width: 1px;
    height: 18px;
    background: var(--sl-text-faint);
  }
  .hover i {
    top: -2px;
    left: 4px;
    transform: none;
    color: var(--sl-text-muted);
  }
  .head {
    position: absolute;
    top: 3px;
    width: 2px;
    height: 20px;
    margin-left: -1px;
    background: var(--sl-playhead);
    border-radius: 1px;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
  }
</style>
