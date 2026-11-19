<script lang="ts">
  import { color } from '@scenegrade/core';
  import type { PlayerController } from '../controller.svelte.js';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';
  import Toggle from './Toggle.svelte';
  import Select from './Select.svelte';
  import IconButton from './IconButton.svelte';

  let { ctl }: { ctl: PlayerController } = $props();
  const s = $derived(ctl.settings);
  let lutName = $state('');
  let lutError = $state('');

  function setCdl(key: 'slope' | 'offset' | 'power', i: number, v: number) {
    const arr = [...s.cdl[key]] as [number, number, number];
    arr[i] = v;
    ctl.update({ cdl: { ...s.cdl, enabled: true, [key]: arr } });
  }
  async function loadLut(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      ctl.player.setUserLut(await f.text(), s.userLut.position);
      lutName = f.name;
      lutError = '';
    } catch (err) {
      lutError = (err as Error).message;
    }
  }
  const presets = [
    { value: 'arri-like', label: 'Stops · ARRI-style' },
    { value: 'el-zone', label: 'Stops · EL Zone' },
  ];
  const legend = $derived(s.falseColor === 'ire' ? color.IRE_FALSE_COLOR.map((b) => ({ c: b.color, l: b.label })) : (color.FALSE_COLOR_PRESETS[s.falseColorPreset as 'arri-like'] ?? []).map((b) => ({ c: b.color, l: b.label })));
  const css = (c: number[]) => `rgb(${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')})`;
</script>

<Section title="Grade (viewer only)">
  {#snippet actions()}
    <IconButton icon="reset" label="Reset grade" size={12} onclick={() => ctl.update({ exposure: 0, gamma: 1, saturation: 1, cdl: { enabled: false, slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 } })} />
  {/snippet}
  <div class="col">
    <Slider label="Exposure" value={s.exposure} min={-10} max={10} step={0.1} digits={1} bipolar onchange={(v) => ctl.update({ exposure: v })} width="100%" />
    <Slider label="Saturation" value={s.saturation} min={0} max={2} step={0.01} reset={1} onchange={(v) => ctl.update({ saturation: v })} width="100%" />
    <Slider label="Gamma" value={s.gamma} min={0.2} max={4} step={0.01} reset={1} onchange={(v) => ctl.update({ gamma: v })} width="100%" />
  </div>
</Section>

<Section title="ASC CDL (in ACEScct)" open={false}>
  <div class="col">
    <Toggle label="Enabled" checked={s.cdl.enabled} onchange={(v) => ctl.update({ cdl: { ...s.cdl, enabled: v } })} />
    {#each ['slope', 'offset', 'power'] as const as key (key)}
      <div class="cdl">
        <span class="k">{key}</span>
        {#each ['R', 'G', 'B'] as ch, i (ch)}
          <Slider label={ch} value={s.cdl[key][i]} min={key === 'offset' ? -0.5 : 0} max={key === 'offset' ? 0.5 : 3} step={0.001} digits={3} reset={key === 'offset' ? 0 : 1} bipolar={key === 'offset'} onchange={(v) => setCdl(key, i, v)} width="100%" />
        {/each}
      </div>
    {/each}
    <Slider label="Sat" value={s.cdl.saturation} min={0} max={2} step={0.001} digits={3} reset={1} onchange={(v) => ctl.update({ cdl: { ...s.cdl, enabled: true, saturation: v } })} width="100%" />
  </div>
</Section>

<Section title="LUT (.cube)" open={false}>
  <div class="col">
    <Select label="Apply" value={s.userLut.position} options={[{ value: 'acescct', label: 'Look, in ACEScct (before view)' }, { value: 'display', label: 'Display LUT (after view)' }]} onchange={(v) => ctl.update({ userLut: { ...s.userLut, position: v as 'acescct' | 'display' } })} />
    <label class="file">
      <input type="file" accept=".cube" onchange={loadLut} />
      <span>{lutName || 'Load .cube…'}</span>
    </label>
    {#if lutError}<p class="err">{lutError}</p>{/if}
    {#if lutName}
      <div class="row">
        <Toggle label="Enabled" checked={s.userLut.enabled} onchange={(v) => ctl.update({ userLut: { ...s.userLut, enabled: v } })} />
        <button type="button" class="link" onclick={() => { ctl.player.setUserLut(null); lutName = ''; }}>Remove</button>
      </div>
    {/if}
  </div>
</Section>

<Section title="False colour">
  <div class="col">
    <Select label="Mode" value={s.falseColor} options={[{ value: 'off', label: 'Off' }, { value: 'stops', label: 'Scene stops' }, { value: 'ire', label: 'Display IRE' }]} onchange={(v) => ctl.update({ falseColor: v as 'off' })} />
    {#if s.falseColor === 'stops'}
      <Select label="Preset" value={s.falseColorPreset} options={presets} onchange={(v) => ctl.update({ falseColorPreset: v })} />
    {/if}
    {#if s.falseColor !== 'off'}
      <ul class="legend">
        {#each legend as b, i (i)}<li><i style:background={css(b.c)}></i>{b.l}</li>{/each}
      </ul>
    {/if}
  </div>
</Section>

<Section title="Zebra & clipping" open={false}>
  <div class="col">
    <Toggle label="Zebra high" checked={s.zebra.high} onchange={(v) => ctl.update({ zebra: { ...s.zebra, high: v } })} />
    <Slider label="≥ %" value={s.zebra.highThreshold} min={50} max={109} step={1} digits={0} reset={95} onchange={(v) => ctl.update({ zebra: { ...s.zebra, highThreshold: v } })} width="100%" />
    <Toggle label="Zebra mid (skin)" checked={s.zebra.low} onchange={(v) => ctl.update({ zebra: { ...s.zebra, low: v } })} />
    <Slider label="Level %" value={s.zebra.lowThreshold} min={10} max={95} step={1} digits={0} reset={70} onchange={(v) => ctl.update({ zebra: { ...s.zebra, lowThreshold: v } })} width="100%" />
    <Slider label="± %" value={s.zebra.lowBand} min={1} max={15} step={1} digits={0} reset={5} onchange={(v) => ctl.update({ zebra: { ...s.zebra, lowBand: v } })} width="100%" />
    <Toggle label="Over (clipped channels)" checked={s.clipping.over} onchange={(v) => ctl.update({ clipping: { ...s.clipping, over: v } })} />
    <Toggle label="Under (crushed)" checked={s.clipping.under} onchange={(v) => ctl.update({ clipping: { ...s.clipping, under: v } })} />
    <Toggle label="NaN / Inf" checked={s.clipping.nan} onchange={(v) => ctl.update({ clipping: { ...s.clipping, nan: v } })} />
    <Toggle label="Focus peaking" checked={s.peaking.enabled} onchange={(v) => ctl.update({ peaking: { ...s.peaking, enabled: v } })} />
    <Slider label="Peak thr." value={s.peaking.threshold} min={0.02} max={0.5} step={0.01} reset={0.12} onchange={(v) => ctl.update({ peaking: { ...s.peaking, threshold: v } })} width="100%" />
  </div>
</Section>

<Section title="HDR" open={false}>
  <div class="col">
    <Toggle label="HDR output when available" checked={s.hdr.enabled} onchange={(v) => ctl.update({ hdr: { ...s.hdr, enabled: v } })} />
    <Slider label="Ref. white" value={s.hdr.referenceWhite} min={80} max={300} step={1} digits={0} reset={203} unit=" nit" onchange={(v) => ctl.update({ hdr: { ...s.hdr, referenceWhite: v } })} width="100%" />
    <p class="note">{ctl.state.hdrDisplay ? 'This display reports HDR.' : 'This display/browser is not in HDR mode: HDR views are shown clipped.'}</p>
  </div>
</Section>

<style>
  .col {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .cdl {
    display: grid;
    gap: 2px;
  }
  .k {
    color: var(--sg-text-muted);
    font-size: var(--sg-text-xs);
    text-transform: capitalize;
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .file input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
  }
  .file span {
    display: block;
    padding: 5px 8px;
    border: 1px dashed var(--sg-border-strong);
    border-radius: var(--sg-radius-sm);
    color: var(--sg-text-muted);
    font-size: var(--sg-text-sm);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file:focus-within span {
    box-shadow: var(--sg-focus);
  }
  .link {
    border: 0;
    background: none;
    color: var(--sg-text-muted);
    font: inherit;
    font-size: var(--sg-text-sm);
    text-decoration: underline;
    cursor: pointer;
  }
  .err {
    margin: 0;
    color: var(--sg-danger);
    font-size: var(--sg-text-sm);
  }
  .note {
    margin: 0;
    color: var(--sg-text-faint);
    font-size: var(--sg-text-xs);
  }
  .legend {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3px 8px;
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--sg-text-muted);
    font-size: var(--sg-text-xs);
  }
  .legend li {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .legend i {
    width: 12px;
    height: 10px;
    border-radius: 2px;
    flex: none;
  }
</style>
