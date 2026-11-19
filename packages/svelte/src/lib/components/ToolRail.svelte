<script lang="ts">
  import type { PlayerController } from '../controller.svelte.js';
  import Btn from './IconButton.svelte';

  let { ctl, oncompare }: { ctl: PlayerController; oncompare?: () => void } = $props();

  const s = $derived(ctl.settings);
  const fcNext = { off: 'stops', stops: 'ire', ire: 'off' } as const;
  const bgNext = { black: 'checker', checker: 'solid', solid: 'black' } as const;
  const MASKS = [0, 2.39, 2.0, 1.85, 1.78, 1.33, 1, 0.8, 0.5625];
  const maskLabel = (a: number) =>
    a ? (a === 0.5625 ? '9:16' : a === 0.8 ? '4:5' : a === 1 ? '1:1' : `${a}:1`) : 'off';
</script>

<nav class="rail" aria-label="Viewer tools">
  <Btn
    icon="wheel"
    label="Grade panel"
    shortcut="E"
    active={ctl.ui.gradeOpen}
    onclick={() => (ctl.ui.gradeOpen = !ctl.ui.gradeOpen)}
  />
  <div class="sep"></div>
  <Btn
    icon="probe"
    label="Pixel probe"
    shortcut="P"
    active={ctl.ui.tool === 'probe'}
    onclick={() => (ctl.ui.tool = ctl.ui.tool === 'probe' ? 'none' : 'probe')}
  />
  <div class="sep"></div>
  <Btn
    icon="falsecolor"
    label="False colour: {s.falseColor}"
    shortcut="X"
    active={s.falseColor !== 'off'}
    onclick={() => ctl.update({ falseColor: fcNext[s.falseColor] })}
  />
  <Btn
    icon="zebra"
    label="Zebra"
    shortcut="Z"
    active={s.zebra.high || s.zebra.low}
    onclick={() =>
      ctl.update({ zebra: { ...s.zebra, high: !(s.zebra.high || s.zebra.low), low: false } })}
  />
  <Btn
    icon="clip"
    label="Clipping, crushed blacks and NaN/Inf"
    shortcut="C"
    active={s.clipping.over || s.clipping.under || s.clipping.nan}
    onclick={() => {
      const on = !(s.clipping.over || s.clipping.under || s.clipping.nan);
      ctl.update({ clipping: { over: on, under: on, nan: on } });
    }}
  />
  <Btn
    icon="peaking"
    label="Focus peaking"
    shortcut="Shift+P"
    active={s.peaking.enabled}
    onclick={() => ctl.update({ peaking: { ...s.peaking, enabled: !s.peaking.enabled } })}
  />
  <div class="sep"></div>
  <Btn
    icon="compare"
    label="Compare A/B"
    shortcut="W"
    active={!!ctl.state.mediaB || ctl.state.compareOriginal}
    onclick={() => oncompare?.()}
  />
  <Btn
    icon="guides"
    label="Safe areas / guides"
    shortcut="Shift+G"
    active={ctl.ui.guides.safeAreas || ctl.ui.guides.thirds || ctl.ui.guides.center}
    onclick={() => {
      const on = !(ctl.ui.guides.safeAreas || ctl.ui.guides.thirds || ctl.ui.guides.center);
      ctl.ui.guides = { ...ctl.ui.guides, safeAreas: on, center: on };
    }}
  />
  <Btn
    icon="fit"
    label="Aspect mask: {maskLabel(ctl.ui.guides.mask)}"
    active={!!ctl.ui.guides.mask}
    onclick={() => {
      const i = MASKS.indexOf(ctl.ui.guides.mask);
      ctl.ui.guides = { ...ctl.ui.guides, mask: MASKS[(i + 1) % MASKS.length] };
    }}
    text={ctl.ui.guides.mask ? maskLabel(ctl.ui.guides.mask) : ''}
  />
  <Btn
    icon="checker"
    label="Alpha background: {s.background}"
    shortcut="B"
    active={s.background !== 'black'}
    onclick={() => ctl.update({ background: bgNext[s.background] })}
  />
  <div class="grow"></div>
  <Btn icon="one" label="Zoom 1:1" shortcut="1" onclick={() => ctl.player.zoomTo(1)} />
  <Btn icon="fit" label="Fit" shortcut="0" onclick={() => ctl.player.fit()} />
  <Btn
    icon="camera"
    label="Snapshot (PNG)"
    onclick={async () => {
      const b = await ctl.player.snapshot();
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `${ctl.state.media?.name ?? 'frame'}_${ctl.player.displayFrameNumber}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }}
  />
  <Btn
    icon="keyboard"
    label="Keyboard shortcuts"
    shortcut="?"
    active={ctl.ui.help}
    onclick={() => (ctl.ui.help = !ctl.ui.help)}
  />
</nav>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    width: var(--sg-rail-w);
    padding: 6px 0;
    border-right: 1px solid var(--sg-border);
    background: var(--sg-surface-1);
    overflow-y: auto;
  }
  .sep {
    width: 20px;
    height: 1px;
    margin: 4px 0;
    background: var(--sg-border);
  }
  .grow {
    flex: 1;
  }
  .rail :global(.has-text) {
    flex-direction: column;
    gap: 0;
    height: auto;
    padding: 4px 2px;
    font-size: 8px;
  }
</style>
