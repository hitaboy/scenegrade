<script lang="ts">
  import type { PlayerController } from '../controller.svelte.js';
  import Scope from './Scope.svelte';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';

  let { ctl }: { ctl: PlayerController } = $props();
  let waveKind = $state<'waveform' | 'parade' | 'waveform-rgb'>('parade');
  let histMode = $state<'display' | 'stops'>('display');
  let histLog = $state(false);
  let gain = $state(1);
  let rev = $state(0);

  function setHistMode(m: 'display' | 'stops') {
    histMode = m;
    ctl.player.scopeOptions.histogramMode = m;
    rev++;
    ctl.player.invalidate();
  }
</script>

<Section title="Waveform">
  {#snippet actions()}
    <div class="seg" role="group" aria-label="Waveform type">
      <button
        type="button"
        class:on={waveKind === 'waveform'}
        onclick={() => (waveKind = 'waveform')}
      >
        Luma
      </button>
      <button type="button" class:on={waveKind === 'parade'} onclick={() => (waveKind = 'parade')}>
        Parade
      </button>
      <button
        type="button"
        class:on={waveKind === 'waveform-rgb'}
        onclick={() => (waveKind = 'waveform-rgb')}
      >
        RGB
      </button>
    </div>
  {/snippet}
  {#key waveKind}<Scope {ctl} kind={waveKind} height={150} {gain} />{/key}
</Section>

<Section title="Vectorscope">
  <Scope {ctl} kind="vectorscope" {gain} />
</Section>

<Section title="Histogram">
  {#snippet actions()}
    <div class="seg" role="group" aria-label="Histogram domain">
      <button
        type="button"
        class:on={histMode === 'display'}
        onclick={() => setHistMode('display')}
        title="Display signal 0–100%"
      >
        Display
      </button>
      <button
        type="button"
        class:on={histMode === 'stops'}
        onclick={() => setHistMode('stops')}
        title="Scene-linear stops around 18% grey"
      >
        Stops
      </button>
      <button
        type="button"
        class:on={histLog}
        onclick={() => (histLog = !histLog)}
        title="Logarithmic count scale"
      >
        Log
      </button>
    </div>
  {/snippet}
  {#key rev}<Scope
      {ctl}
      kind="histogram"
      height={110}
      logScale={histLog}
      channels={{ r: true, g: true, b: true, luma: true }}
    />{/key}
</Section>

<div class="foot">
  <Slider
    label="Scope gain"
    value={gain}
    min={0.1}
    max={8}
    step={0.1}
    reset={1}
    digits={1}
    onchange={(v) => (gain = v)}
    width="100%"
  />
</div>

<style>
  .seg {
    display: inline-flex;
    border: 1px solid var(--sg-border);
    border-radius: var(--sg-radius-sm);
    overflow: hidden;
  }
  .seg button {
    height: 20px;
    padding: 0 7px;
    border: 0;
    background: none;
    color: var(--sg-text-faint);
    font: inherit;
    font-size: var(--sg-text-xs);
    cursor: pointer;
  }
  .seg button + button {
    border-left: 1px solid var(--sg-border);
  }
  .seg button.on {
    background: var(--sg-surface-3);
    color: var(--sg-text);
  }
  .foot {
    padding: 8px 10px;
  }
</style>
