<script lang="ts">
  import { color } from '@scenelinear/core';
  import type { PlayerController } from '../controller.svelte.js';
  import Select, { type Option } from './Select.svelte';
  import Slider from './Slider.svelte';
  import IconButton from './IconButton.svelte';

  let { ctl, onopen }: { ctl: PlayerController; onopen?: () => void } = $props();

  const inputOptions: Option[] = color.INPUT_SPACES.map((s) => ({ value: s.id, label: s.label, group: s.family }));
  const viewOptions: Option[] = [
    ...color.VIEWS.map((v) => ({ value: v.id, label: v.label, group: v.display })),
    ...color.ANALYTIC_VIEWS.map((v) => ({ value: v.id, label: v.label, group: 'Utility' })),
  ];
  const channelOptions: Option[] = [
    { value: 'rgb', label: 'RGB' },
    { value: 'r', label: 'Red' },
    { value: 'g', label: 'Green' },
    { value: 'b', label: 'Blue' },
    { value: 'a', label: 'Alpha' },
    { value: 'luma', label: 'Luminance' },
  ];
  const layerOptions = $derived((ctl.state.media?.layers ?? []).map((l) => ({ value: l.name, label: l.name || 'RGBA (default)' })));
  const view = $derived(color.VIEWS.find((v) => v.id === ctl.settings.view));
  const hint = $derived(ctl.state.media?.colorHints);
</script>

<header class="tb">
  <div class="name">
    {#if onopen}<IconButton icon="open" label="Open media" shortcut="Ctrl+O" onclick={onopen} />{/if}
    <span class="file" title={ctl.state.media?.name}>{ctl.state.media?.name ?? 'No media'}</span>
    {#if ctl.state.media}
      <span class="badge" title="Codec / pixel format">{ctl.state.media.codec}{ctl.state.media.bitDepth ? ` · ${ctl.state.media.bitDepth}-bit` : ''}</span>
    {/if}
  </div>

  <div class="color">
    <span title={hint?.reason ? `Detected: ${hint.inputSpace} (${hint.reason})` : ''}>
      <Select label="Input" value={ctl.settings.inputSpace} options={inputOptions} onchange={(v) => ctl.update({ inputSpace: v })} width="190px" />
    </span>
    <Select label="View" value={ctl.settings.view} options={viewOptions} onchange={(v) => ctl.update({ view: v })} width="250px" />
    {#if view?.hdr}
      <span class="hdr" class:off={!ctl.state.hdrDisplay} title={ctl.state.hdrDisplay ? 'HDR output active' : 'This display/browser is not in HDR: highlights are clipped'}>HDR {view.peakNits}</span>
    {/if}
  </div>

  <div class="grade">
    <Slider label="EV" value={ctl.settings.exposure} min={-10} max={10} step={0.1} digits={1} bipolar onchange={(v) => ctl.update({ exposure: v })} width="150px" />
    <Slider label="γ" value={ctl.settings.gamma} min={0.2} max={4} step={0.01} reset={1} onchange={(v) => ctl.update({ gamma: v })} width="120px" />
    <Select label="Ch" value={ctl.settings.channel} options={channelOptions} onchange={(v) => ctl.update({ channel: v as never })} width="110px" />
    {#if layerOptions.length > 1}
      <Select label="Layer" value={ctl.state.layer} options={layerOptions} onchange={(v) => ctl.player.setLayer(v)} width="160px" />
    {/if}
  </div>
</header>

<style>
  .tb {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 16px;
    min-height: 40px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--sl-border);
    background: var(--sl-surface-1);
  }
  .name {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1 1 200px;
  }
  .file {
    overflow: hidden;
    color: var(--sl-text);
    font-size: var(--sl-text-md);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    flex: none;
    padding: 1px 6px;
    border: 1px solid var(--sl-border);
    border-radius: 10px;
    color: var(--sl-text-muted);
    font: var(--sl-text-xs) var(--sl-font-mono);
    white-space: nowrap;
  }
  .color,
  .grade {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
  }
  .hdr {
    padding: 1px 6px;
    border-radius: var(--sl-radius-sm);
    background: var(--sl-accent-weak);
    color: var(--sl-accent);
    font: 600 var(--sl-text-xs) var(--sl-font-mono);
  }
  .hdr.off {
    background: none;
    border: 1px solid var(--sl-warn);
    color: var(--sl-warn);
  }
</style>
